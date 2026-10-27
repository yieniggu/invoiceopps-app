import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "./features/profile/ProfileScreen";
import { renderApp } from "./test/renderApp";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = { id: id(1), name: "Academia", slug: "academy" };
const base = `/api/v1/organizations/${org.id}`;
const other = {
  userId: id(4),
  organizationId: org.id,
  role: "USER",
  user: { id: id(4), name: "Otra Persona", rut: "190347907" },
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function failure(status: number, code: string) {
  return json({ error: { code, message: "private-stack" } }, status);
}
function http(platform = true, role = "USER", member = true) {
  let profile: Profile = {
    id: id(2),
    name: "Persona",
    rut: "12345678-5",
    email: null,
    username: null,
    isPlatformAdministrator: platform,
    memberships: member ? [{ organization: org, role }] : [],
  };
  const reads = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ profile }));
  const members = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () =>
      json({
        memberships: [
          {
            userId: profile.id,
            organizationId: org.id,
            role,
            user: { id: profile.id, name: "Persona", rut: "123456785" },
          },
          other,
        ],
      }),
    );
  const writes = vi
    .fn<(path: string, init: RequestInit) => Promise<Response>>()
    .mockImplementation(async (path, init) =>
      init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : json(
            {
              membership: {
                organizationId: org.id,
                userId: init.method === "POST" ? id(5) : path.split("/").at(-1),
                role: JSON.parse(String(init.body)).role,
              },
            },
            init.method === "POST" ? 201 : 200,
          ),
    );
  const discovery = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ organizations: [] }));
  const policyWrite = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => {
      throw new Error("unknown policy");
    });
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://test.invalid").pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/v1/auth/profile") return reads();
      if (path === "/api/v1/groups") return json({ groups: [] });
      if (path === "/api/v1/organizations") return discovery();
      if (path === `${base}/memberships` && method === "GET") return members();
      if (path.startsWith(`${base}/memberships`))
        return writes(path, init ?? {});
      if (path.startsWith("/api/v1/business-policies"))
        return init?.method
          ? policyWrite()
          : json({ policies: [{ version: "v1", manualReviewThreshold: 0.8 }] });
      throw new Error(`Unexpected request ${method} ${path}`);
    });
  return {
    reads,
    members,
    writes,
    discovery,
    fetchMock,
    policyWrite,
    setProfile: (next: Profile) => {
      profile = next;
    },
    getProfile: () => profile,
  };
}
// The active context is observable on the dashboard "Tu espacio de trabajo" card.
function dashboardContext() {
  fireEvent.click(
    within(screen.getByRole("navigation")).getByRole("link", {
      name: "Panel principal",
    }),
  );
  return screen.getByRole("region", { name: "Tu espacio de trabajo" });
}
/** People are managed on the organization detail, reached from the list. */
async function openOrganization() {
  fireEvent.click(await screen.findByRole("link", { name: "Organizaciones" }));
  fireEvent.click(
    await screen.findByRole("link", { name: "Ver detalle de Academia" }),
  );
}
async function open() {
  const view = renderApp();
  await openOrganization();
  await screen.findByText("Otra Persona");
  return view;
}
function refocus() {
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("APP12 S7 administration", () => {
  it.each([
    [false, "ADMIN"],
    [true, "USER"],
  ] as const)(
    "exposes people management on the organization detail for platform=%s role=%s",
    async (platform, role) => {
      const api = http(platform, role);
      renderApp();
      const nav = await screen.findByRole("navigation");
      // There is no separate administration destination any more.
      expect(
        within(nav).queryByRole("link", { name: "Administración" }),
      ).toBeNull();
      await openOrganization();
      expect(
        await screen.findByRole("heading", { level: 1, name: "Academia" }),
      ).toBeTruthy();
      if (role === "ADMIN") {
        expect(await screen.findByText("Otra Persona")).toBeTruthy();
        expect(screen.getByLabelText(/RUT de la persona/)).toBeTruthy();
      } else {
        // Platform authority alone administers no organization's people.
        expect(screen.queryByLabelText(/RUT de la persona/)).toBeNull();
        expect(api.members).not.toHaveBeenCalled();
      }
      expect(
        screen.queryByRole("link", { name: "Crear organización" }),
      ).toBeNull();
    },
  );

  it("never exposes administration or discovery to a regular student", async () => {
    const api = http(false);
    renderApp();
    const nav = await screen.findByRole("navigation");
    expect(
      within(nav).queryByRole("link", { name: "Administración" }),
    ).toBeNull();
    expect(api.discovery).not.toHaveBeenCalled();
    expect(api.members).not.toHaveBeenCalled();
    await openOrganization();
    await screen.findByRole("heading", { level: 1, name: "Academia" });
    expect(screen.queryByLabelText(/RUT de la persona/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Asignar persona" }),
    ).toBeNull();
    expect(api.members).not.toHaveBeenCalled();
  });

  it("confirms the exact POST, PATCH and DELETE contracts and never parses DELETE 204", async () => {
    const api = http(false, "ADMIN");
    const empty = new Response(null, { status: 204 });
    const parse = vi.spyOn(empty, "json");
    api.writes.mockImplementation(async (_path, init) =>
      init.method === "DELETE"
        ? empty
        : json(
            {
              membership: {
                organizationId: org.id,
                userId: id(4),
                role: "ADMIN",
              },
            },
            init.method === "POST" ? 201 : 200,
          ),
    );
    await open();

    // POST: assign by RUT; the API form of the RUT and the exact enum travel.
    fireEvent.change(screen.getByLabelText(/RUT de la persona/), {
      target: { value: "190347907" },
    });
    fireEvent.change(screen.getByLabelText("Rol a asignar"), {
      target: { value: "ADMIN" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Asignar persona" }));
    await screen.findByText("Persona asignada a la organización.");
    const [postPath, post] = api.writes.mock.calls[0];
    expect(postPath).toBe(`${base}/memberships`);
    expect(post.method).toBe("POST");
    expect(post.credentials).toBe("same-origin");
    expect(post.body).toBe(
      JSON.stringify({ rut: "19034790-7", role: "ADMIN" }),
    );

    // PATCH: the exact ADMIN enum, never a translated role label.
    fireEvent.change(screen.getByLabelText("Rol de Otra Persona"), {
      target: { value: "ADMIN" },
    });
    await waitFor(() => expect(api.writes).toHaveBeenCalledTimes(2));
    const [patchPath, patch] = api.writes.mock.calls[1];
    expect(patchPath).toBe(`${base}/memberships/${id(4)}`);
    expect(patch.method).toBe("PATCH");
    expect(patch.body).toBe(JSON.stringify({ role: "ADMIN" }));
    expect(api.getProfile().memberships[0].role).toBe("ADMIN");

    // DELETE: asks for confirmation first; cancelling sends nothing.
    const remove = screen.getByRole("button", {
      name: "Quitar a Otra Persona",
    });
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(api.writes).toHaveBeenCalledTimes(2);
    fireEvent.click(
      screen.getByRole("button", { name: "Quitar a Otra Persona" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Otra Persona" }),
    );
    await waitFor(() => expect(api.writes).toHaveBeenCalledTimes(3));
    const [deletePath, del] = api.writes.mock.calls[2];
    expect(deletePath).toBe(`${base}/memberships/${id(4)}`);
    expect(del.method).toBe("DELETE");
    expect(del.body).toBeUndefined();
    expect(parse).not.toHaveBeenCalled();
    expect(
      api.fetchMock.mock.calls.some(([path]) =>
        /invoices|business-policies/.test(String(path)),
      ),
    ).toBe(false);
  });

  it("validates the RUT and exposes no global directory", async () => {
    const api = http(false, "ADMIN");
    await open();
    fireEvent.change(screen.getByLabelText(/RUT de la persona/), {
      target: { value: "190347908" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Asignar persona" }));
    expect(screen.getByText("RUT inválido")).toBeTruthy();
    expect(api.writes).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/correo/i)).toBeNull();
    // Only this organization's memberships are ever listed.
    expect(
      api.fetchMock.mock.calls.every(
        ([path]) => !/\/users($|\?)/.test(String(path)),
      ),
    ).toBe(true);
  });

  it.each([
    [400, "VALIDATION_ERROR", "Revisa los datos ingresados"],
    [403, "FORBIDDEN", "No tienes permiso"],
    [404, "USER_NOT_FOUND", "No existe una persona registrada"],
    [409, "MEMBERSHIP_CONFLICT", "ya pertenece"],
  ])(
    "retains the draft and safely explains HTTP %s without logout or raw error disclosure",
    async (status, code, text) => {
      const api = http(false, "ADMIN");
      api.writes.mockResolvedValueOnce(failure(status, code));
      await open();
      fireEvent.change(screen.getByLabelText(/RUT de la persona/), {
        target: { value: "190347907" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Asignar persona" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(text);
      expect(document.body.textContent).not.toContain("private-stack");
      expect(screen.getByLabelText(/RUT de la persona/)).toHaveProperty(
        "value",
        "19.034.790-7",
      );
      expect(screen.getByRole("navigation")).toBeTruthy();
      expect(api.writes).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: "Asignar persona" }),
      ).toHaveProperty("disabled", false);
    },
  );

  it("removes the administrative actions when the refreshed profile revokes the capability", async () => {
    const api = http(false, "ADMIN");
    await open();
    api.setProfile({
      ...api.getProfile(),
      memberships: [{ organization: org, role: "USER" }],
    });
    refocus();
    await waitFor(() =>
      expect(screen.queryByLabelText(/RUT de la persona/)).toBeNull(),
    );
    expect(screen.queryByText("Otra Persona")).toBeNull();
    expect(api.writes).not.toHaveBeenCalled();
  });

  it("keeps a confirmed write when the refresh fails and retries only the read", async () => {
    const api = http(false, "ADMIN");
    await open();
    api.members.mockResolvedValueOnce(json({}, 500));
    fireEvent.change(screen.getByLabelText("Rol de Otra Persona"), {
      target: { value: "ADMIN" },
    });
    await screen.findByText("Rol actualizado.");
    expect(
      await screen.findByText(
        "No fue posible actualizar la lista de miembros. Tus cambios ya se guardaron; no repitas la operación.",
      ),
    ).toBeTruthy();
    // The members already on screen stay visible.
    expect(screen.getByText("Otra Persona")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Reintentar miembros" }),
    );
    await waitFor(() => expect(api.members).toHaveBeenCalledTimes(3));
    expect(api.writes).toHaveBeenCalledTimes(1);
  });

  it("refreshes self removal from the real profile and clears the revoked workspace without falling back", async () => {
    const api = http(true, "ADMIN");
    await open();
    api.writes.mockImplementationOnce(async () => {
      api.setProfile({ ...api.getProfile(), memberships: [] });
      return new Response(null, { status: 204 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Quitar a Persona" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Persona" }),
    );
    await waitFor(() =>
      expect(api.reads.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() =>
      expect(dashboardContext().textContent).toContain(
        "Elige una organización o grupo para empezar.",
      ),
    );
    // The revoked organization is gone from the list, not left as a stale card.
    fireEvent.click(screen.getByRole("link", { name: "Organizaciones" }));
    expect(
      await screen.findByText(/Aún no perteneces a ninguna organización/),
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Ver detalle de Academia" }),
    ).toBeNull();
    expect(screen.queryByLabelText(/RUT de la persona/)).toBeNull();
  });

  it("expires the current session on a current mutation 401", async () => {
    const api = http(false, "ADMIN");
    api.writes.mockResolvedValueOnce(failure(401, "UNAUTHENTICATED"));
    await open();
    fireEvent.change(screen.getByLabelText("Rol de Otra Persona"), {
      target: { value: "ADMIN" },
    });
    await screen.findByRole("button", { name: "Iniciar sesión" });
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("preserves the unrelated policy operation ledger through a same-actor self-membership refresh", async () => {
    const api = http(true, "ADMIN");
    renderApp();
    fireEvent.click(await screen.findByRole("link", { name: /^Políticas$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Editar v1" }));
    fireEvent.change(
      screen.getByLabelText("Umbral de revisión manual (0 a 1)"),
      { target: { value: "1" } },
    );
    fireEvent.submit(screen.getByRole("form", { name: "Editar política" }));
    await screen.findByText(/resultado es desconocido/i);
    await openOrganization();
    await screen.findByText("Otra Persona");
    api.writes.mockImplementationOnce(async () => {
      api.setProfile({
        ...api.getProfile(),
        memberships: [{ organization: org, role: "USER" }],
      });
      return json({
        membership: {
          userId: api.getProfile().id,
          organizationId: org.id,
          role: "USER",
        },
      });
    });
    fireEvent.change(screen.getByLabelText("Rol de Persona"), {
      target: { value: "USER" },
    });
    await screen.findByText("Rol actualizado.");
    // The refreshed profile arrives for the same actor.
    await waitFor(() =>
      expect(api.reads.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    fireEvent.click(screen.getByRole("link", { name: /^Políticas$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Editar v1" }));
    await screen.findByText(/resultado es desconocido/i);
    expect(
      screen.getByLabelText("Umbral de revisión manual (0 a 1)"),
    ).toHaveProperty("value", "1");
    expect(api.policyWrite).toHaveBeenCalledTimes(1);
  });
});
