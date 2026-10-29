import { membership, NO_PERMISSIONS } from "./test/transport";
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
import { openPolicies } from "./test/policiesRoute";
import { renderApp } from "./test/renderApp";

// Políticas is disabled in the product; the screen is kept unrouted. The
// policy-ledger test keeps exercising it through the test-only route.
vi.mock("./features/session/AppRoutes", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./features/session/AppRoutes")>();
  const { withPoliciesRoute } = await import("./test/policiesRoute");
  return { ...original, AppRoutes: withPoliciesRoute(original.AppRoutes) };
});

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = { id: id(1), name: "Academia", slug: "academy" };
const base = `/api/v1/organizations/${org.id}`;
const other = {
  userId: id(4),
  organizationId: org.id,
  role: "USER",
  permissions: NO_PERMISSIONS,
  groups: [],
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
    memberships: member ? [membership(org, role as "ADMIN" | "USER")] : [],
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
            permissions: NO_PERMISSIONS,
            groups: [],
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
    // The platform directory lists every organization (paginated).
    .mockImplementation(async () =>
      json({
        organizations: [{ ...org, description: null }],
        page: 1,
        pageSize: 20,
        total: 1,
      }),
    );
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
      if (path === base && method === "GET")
        return json({
          organization: { ...org, description: null },
          summary: { memberCount: 2, groupCount: 0 },
        });
      if (path === `${base}/groups` && method === "GET")
        return json({ groups: [] });
      if (path === `${base}/memberships` && method === "GET") return members();
      // The reduced list every member may read (plain members use it).
      if (path === `${base}/members` && method === "GET")
        return json({
          members: [
            {
              userId: id(2),
              name: "Persona",
              email: null,
              recentlyActive: true,
            },
            {
              userId: other.userId,
              name: other.user.name,
              email: null,
              recentlyActive: false,
            },
          ],
          page: 1,
          pageSize: 20,
          total: 2,
        });
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
/** The organization summary, reached from the list. */
async function openOrganization() {
  fireEvent.click(await screen.findByRole("link", { name: "Organizaciones" }));
  fireEvent.click(
    await screen.findByRole("link", { name: "Ver detalle de Academia" }),
  );
}
/** People are managed on their own screens: members table, then the person. */
async function openMembers() {
  await openOrganization();
  fireEvent.click(await screen.findByRole("link", { name: "Miembros" }));
  await screen.findByRole("link", { name: "Otra Persona" });
}
async function openMember(name: string) {
  fireEvent.click(await screen.findByRole("link", { name }));
  await screen.findByRole("heading", { level: 1, name });
}
async function open() {
  const view = renderApp();
  await openMembers();
  return view;
}
/** The add-member screen, with the "existing person" tab selected. */
async function openAddMember() {
  const view = renderApp();
  await openOrganization();
  fireEvent.click(await screen.findByRole("link", { name: "Agregar miembro" }));
  await screen.findByRole("heading", { level: 1, name: "Agregar miembro" });
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
    "exposes people management on the organization screens for platform=%s role=%s",
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
      // v2: organization ADMIN and platform administrator both manage people.
      expect(
        await screen.findByRole("link", { name: "Miembros" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("link", { name: "Agregar miembro" }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("link", { name: "Miembros" }));
      expect(
        await screen.findByRole("link", { name: "Otra Persona" }),
      ).toBeTruthy();
      expect(api.members).toHaveBeenCalled();
      fireEvent.click(screen.getByRole("link", { name: "Agregar miembro" }));
      await screen.findByRole("heading", { level: 1, name: "Agregar miembro" });
      expect(screen.getByLabelText(/RUT de la persona/)).toBeTruthy();
      fireEvent.click(screen.getByRole("tab", { name: "Crear persona nueva" }));
      if (platform) {
        // The platform can also use the multi-organization wizard, org preselected.
        expect(
          screen
            .getByRole("link", {
              name: /Usa el asistente de administración/,
            })
            .getAttribute("href"),
        ).toBe(`/admin/users/new?organizationId=${org.id}`);
      } else {
        // The ADMIN creates users in place: single-organization wizard.
        expect(
          screen.queryByRole("link", {
            name: /Usa el asistente de administración/,
          }),
        ).toBeNull();
        expect(
          screen.getByRole("heading", { name: "Crear usuario nuevo" }),
        ).toBeTruthy();
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
    // A plain member sees the summary, the groups and the reduced member list
    // (AC-22), but none of the people-management screens.
    expect(screen.getByRole("link", { name: "Miembros" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Agregar miembro" })).toBeNull();
    expect(screen.queryByLabelText(/RUT de la persona/)).toBeNull();
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
    await openAddMember();

    // POST: add by RUT; the API form of the RUT and the exact enum travel.
    fireEvent.change(screen.getByLabelText(/RUT de la persona/), {
      target: { value: "190347907" },
    });
    fireEvent.change(screen.getByLabelText("Rol a asignar"), {
      target: { value: "ADMIN" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Agregar persona" }));
    // Success goes back to the members list with a status message.
    await screen.findByText("Persona agregada a la organización.");
    expect(window.location.pathname).toBe(`/organizations/${org.id}/members`);
    const [postPath, post] = api.writes.mock.calls[0];
    expect(postPath).toBe(`${base}/memberships`);
    expect(post.method).toBe("POST");
    expect(post.credentials).toBe("same-origin");
    expect(post.body).toBe(
      JSON.stringify({
        rut: "19034790-7",
        role: "ADMIN",
        permissions: NO_PERMISSIONS,
      }),
    );

    // PATCH: the exact ADMIN enum, never a translated role label.
    await openMember("Otra Persona");
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
      name: "Quitar a Otra Persona de la organización",
    });
    fireEvent.click(remove);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(api.writes).toHaveBeenCalledTimes(2);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Quitar a Otra Persona de la organización",
      }),
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
    await openAddMember();
    fireEvent.change(screen.getByLabelText(/RUT de la persona/), {
      target: { value: "190347908" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Agregar persona" }));
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
      await openAddMember();
      fireEvent.change(screen.getByLabelText(/RUT de la persona/), {
        target: { value: "190347907" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Agregar persona" }));
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
        screen.getByRole("button", { name: "Agregar persona" }),
      ).toHaveProperty("disabled", false);
    },
  );

  it("removes the administrative actions when the refreshed profile revokes the capability", async () => {
    const api = http(false, "ADMIN");
    await open();
    api.setProfile({
      ...api.getProfile(),
      memberships: [membership(org, "USER")],
    });
    refocus();
    // The management table is replaced by the reduced list (AC-22): the name
    // stays, every administrative control goes.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Editar permisos en bloque" }),
      ).toBeNull(),
    );
    expect(
      await screen.findByRole("link", { name: "Otra Persona" }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Agregar miembro" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(api.writes).not.toHaveBeenCalled();
  });

  it("keeps a confirmed write when the refresh fails and retries only the read", async () => {
    const api = http(false, "ADMIN");
    await open();
    await openMember("Otra Persona");
    api.members.mockResolvedValueOnce(json({}, 500));
    fireEvent.change(screen.getByLabelText("Rol de Otra Persona"), {
      target: { value: "ADMIN" },
    });
    await screen.findByText("Rol actualizado.");
    expect(
      await screen.findByText(
        "No fue posible actualizar los datos del miembro. Tus cambios ya se guardaron; no repitas la operación.",
      ),
    ).toBeTruthy();
    // The member already on screen stays visible.
    expect(
      screen.getByRole("heading", { level: 1, name: "Otra Persona" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar miembro" }));
    // The list, the member page mounting on a stale list, the refresh after
    // the write (500) and the single retried read.
    await waitFor(() => expect(api.members).toHaveBeenCalledTimes(4));
    expect(api.writes).toHaveBeenCalledTimes(1);
  });

  it("refreshes self removal from the real profile and clears the revoked workspace without falling back", async () => {
    // Not a platform administrator: their directory lists every organization,
    // while a member's list is the profile's memberships (the point here).
    const api = http(false, "ADMIN");
    await open();
    await openMember("Persona");
    api.writes.mockImplementationOnce(async () => {
      api.setProfile({ ...api.getProfile(), memberships: [] });
      return new Response(null, { status: 204 });
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Quitar a Persona de la organización",
      }),
    );
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
    await openMember("Otra Persona");
    fireEvent.change(screen.getByLabelText("Rol de Otra Persona"), {
      target: { value: "ADMIN" },
    });
    await screen.findByRole("button", { name: "Iniciar sesión" });
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("preserves the unrelated policy operation ledger through a same-actor self-membership refresh", async () => {
    const api = http(true, "ADMIN");
    renderApp();
    await screen.findByRole("heading", { name: "Panel principal" });
    await openPolicies();
    fireEvent.click(await screen.findByRole("button", { name: "Editar v1" }));
    fireEvent.change(
      screen.getByLabelText("Umbral de revisión manual (0 a 1)"),
      { target: { value: "1" } },
    );
    fireEvent.submit(screen.getByRole("form", { name: "Editar política" }));
    await screen.findByText(/resultado es desconocido/i);
    await openMembers();
    await openMember("Persona");
    api.writes.mockImplementationOnce(async () => {
      api.setProfile({
        ...api.getProfile(),
        memberships: [membership(org, "USER")],
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
    // It is the actor's own role: nothing is sent until they confirm.
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirmar cambio de rol" }),
    );
    await screen.findByText("Rol actualizado.");
    // The refreshed profile arrives for the same actor.
    await waitFor(() =>
      expect(api.reads.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    await openPolicies();
    fireEvent.click(await screen.findByRole("button", { name: "Editar v1" }));
    await screen.findByText(/resultado es desconocido/i);
    expect(
      screen.getByLabelText("Umbral de revisión manual (0 a 1)"),
    ).toHaveProperty("value", "1");
    expect(api.policyWrite).toHaveBeenCalledTimes(1);
  });
});
