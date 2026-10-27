import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Profile } from "./features/profile/ProfileScreen";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = { id: id(1), name: "Academia", slug: "academy" };
const target = "abcdefab-cdef-4abc-8abc-abcdefabcdef";
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
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
  const writes = vi
    .fn<(path: string, init: RequestInit) => Promise<Response>>()
    .mockImplementation(async (path, init) =>
      init.method === "DELETE"
        ? new Response(null, { status: 204 })
        : json(
            {
              membership: {
                organizationId: org.id,
                userId:
                  init.method === "POST"
                    ? JSON.parse(String(init.body)).userId
                    : path.split("/").at(-1),
                role: JSON.parse(String(init.body)).role,
              },
            },
            init.method === "POST" ? 201 : 200,
          ),
    );
  const logout = vi
    .fn<() => Promise<Response>>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  const discovery = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () =>
      json({ organizations: [{ ...org, groups: [] }] }),
    );
  const policyWrite = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => {
      throw new Error("unknown policy");
    });
  const invoice = {
    id: "INV-A",
    businessId: "INV-A",
    organizationId: "organization-1",
    groupId: "group-1",
    currency: "CLP",
    issuedOn: "2026-10-25",
    dueOn: "2026-11-25",
    processingStatus: "NOT_REQUESTED",
    createdByUserId: "user-1",
    supplierName: "Proveedor",
    amountPesos: 100,
    businessStatus: "PENDING",
    createdAt: "2026-10-21T00:00:00Z",
  };
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const path = new URL(String(input), "http://test.invalid").pathname;
      if (path === "/api/v1/auth/profile") return reads();
      if (path === "/api/v1/groups") return json({ groups: [] });
      if (path === "/api/v1/platform/organizations") return discovery();
      if (path.startsWith("/api/v1/platform/organizations/"))
        return writes(path, init ?? {});
      if (path === "/api/v1/auth/logout") return logout();
      if (path === "/api/v1/auth/login") return json({});
      if (path.startsWith("/api/v1/business-policies"))
        return init?.method
          ? policyWrite()
          : json({ policies: [{ version: "v1", manualReviewThreshold: 0.8 }] });
      if (path.startsWith("/api/v1/invoices"))
        return path === "/api/v1/invoices"
          ? json({ invoices: [invoice], nextCursor: null })
          : json({ invoice });
      throw new Error(`Unexpected request ${path}`);
    });
  return {
    reads,
    writes,
    discovery,
    logout,
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
    within(screen.getByRole("navigation")).getByRole("button", {
      name: "Panel principal",
    }),
  );
  return screen.getByRole("region", { name: "Tu espacio de trabajo" });
}
async function open() {
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /^Administración$/ }),
  );
}
function draft(method = "POST", userId = target) {
  fireEvent.change(screen.getByLabelText("Organización administrada"), {
    target: { value: org.id },
  });
  fireEvent.change(screen.getByLabelText("UUID de usuario existente"), {
    target: { value: userId },
  });
  fireEvent.change(screen.getByLabelText("Operación de membresía"), {
    target: { value: method },
  });
}
function review() {
  fireEvent.click(screen.getByRole("button", { name: "Revisar operación" }));
}
function confirm() {
  fireEvent.click(screen.getByRole("button", { name: "Confirmar operación" }));
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
    "exposes management navigation and dashboard for platform=%s role=%s",
    async (platform, role) => {
      const api = http(platform, role);
      render(<App />);
      const nav = await screen.findByRole("navigation");
      expect(
        within(nav).getByRole("button", { name: "Administración" }),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "Ir a administración" }),
      );
      expect(
        screen.getByRole("heading", { level: 1, name: "Administración" }),
      ).toBeTruthy();
      if (!platform) {
        expect(screen.queryByLabelText("UUID de usuario existente")).toBeNull();
        expect(api.discovery).not.toHaveBeenCalled();
        fireEvent.click(
          screen.getByRole("button", {
            name: "Administrar grupos en Mis grupos",
          }),
        );
        expect(
          screen.getByRole("heading", { name: "Crear grupo" }),
        ).toBeTruthy();
      }
    },
  );
  it("never exposes administration or discovery to a regular student", async () => {
    const api = http(false);
    render(<App />);
    await screen.findByRole("navigation");
    expect(screen.queryByRole("button", { name: "Administración" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Ir a administración" }),
    ).toBeNull();
    expect(api.discovery).not.toHaveBeenCalled();
  });
  it.each(["POST", "PATCH", "DELETE"])(
    "confirms the exact %s contract, retains a target summary and never parses DELETE 204",
    async (method) => {
      const api = http(true, "USER", false);
      const empty = new Response(null, { status: 204 });
      const parse = vi.spyOn(empty, "json");
      if (method === "DELETE") api.writes.mockResolvedValueOnce(empty);
      await open();
      await screen.findByRole("option", { name: /Academia/ });
      draft(method, ` ${target.toUpperCase()} `);
      review();
      expect(api.writes).not.toHaveBeenCalled();
      expect(
        screen.getByRole("heading", {
          name: "Confirmar intención administrativa",
        }),
      ).toBe(document.activeElement);
      const confirmation = screen.getByRole("region", {
        name: "Confirmar intención administrativa",
      });
      expect(within(confirmation).getByText(target)).toBeTruthy();
      expect(
        within(confirmation).getByText(`${org.name} · ${org.id}`),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", { name: "Cancelar operación" }),
      );
      expect(api.writes).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Revisar operación" }),
      );
      review();
      confirm();
      await screen.findByText(/Operación confirmada por el servidor/);
      expect(api.writes).toHaveBeenCalledTimes(1);
      const [path, init] = api.writes.mock.calls[0];
      expect(path).toBe(
        `/api/v1/platform/organizations/${encodeURIComponent(org.id)}/members${method === "POST" ? "" : `/${encodeURIComponent(target)}`}`,
      );
      expect(init.method).toBe(method);
      expect(init.credentials).toBe("same-origin");
      expect(init.body).toBe(
        method === "DELETE"
          ? undefined
          : JSON.stringify(
              method === "POST"
                ? { userId: target, role: "USER" }
                : { role: "USER" },
            ),
      );
      expect(parse).not.toHaveBeenCalled();
      expect(dashboardContext().textContent).toContain(
        "Elige una organización o grupo para empezar.",
      );
      expect(
        api.fetchMock.mock.calls.some(([path]) =>
          /invoices|business-policies/.test(String(path)),
        ),
      ).toBe(false);
    },
  );
  it("validates a manual UUID and organization without exposing a directory", async () => {
    const api = http();
    await open();
    draft("POST", "not-a-uuid");
    review();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("UUID de usuario válido"),
    );
    expect(api.writes).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/correo/i)).toBeNull();
    draft();
    fireEvent.change(screen.getByLabelText("Organización administrada"), {
      target: { value: "" },
    });
    review();
    expect(api.writes).not.toHaveBeenCalled();
  });
  it.each([400, 403, 404, 409])(
    "retains the draft and safely explains HTTP %s without logout or raw error disclosure",
    async (status) => {
      const api = http();
      api.writes.mockResolvedValueOnce(
        json({ message: "private-stack" }, status),
      );
      await open();
      draft("PATCH");
      review();
      confirm();
      await screen.findByRole("alert");
      expect(document.body.textContent).not.toContain("private-stack");
      if (status === 409)
        expect(screen.getByRole("alert").textContent).toContain(
          "conservar un administrador",
        );
      expect(screen.getByLabelText("UUID de usuario existente")).toHaveProperty(
        "value",
        target,
      );
      expect(screen.getByRole("navigation")).toBeTruthy();
      expect(api.writes).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("button", { name: "Revisar operación" }),
      ).toHaveProperty("disabled", false);
    },
  );
  it("locks synchronously during preflight and POST, preserving the intent across route remounts", async () => {
    const api = http();
    await open();
    draft();
    review();
    const preflight = deferred<Response>();
    api.reads.mockReturnValueOnce(preflight.promise);
    const mutation = deferred<Response>();
    api.writes.mockReturnValueOnce(mutation.promise);
    confirm();
    expect(screen.getByLabelText("UUID de usuario existente")).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Panel principal$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Administración$/ }));
    expect(
      screen.getByRole("button", { name: "Revisar operación" }),
    ).toHaveProperty("disabled", true);
    expect(api.writes).not.toHaveBeenCalled();
    await act(async () =>
      preflight.resolve(json({ profile: api.getProfile() })),
    );
    await waitFor(() => expect(api.writes).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Revisar operación" }));
    expect(api.writes).toHaveBeenCalledTimes(1);
    await act(async () =>
      mutation.resolve(
        json(
          {
            membership: {
              userId: target,
              organizationId: org.id,
              role: "USER",
            },
          },
          201,
        ),
      ),
    );
    await screen.findByText(/Operación confirmada/);
  });
  it.each(["network", "500", "mismatch"])(
    "blocks unknown %s across navigation and isolates another target",
    async (failure) => {
      const api = http();
      if (failure === "network")
        api.writes.mockRejectedValueOnce(new Error("private-network"));
      else
        api.writes.mockResolvedValueOnce(
          json(
            {
              membership: {
                userId: id(99),
                organizationId: org.id,
                role: "USER",
              },
            },
            failure === "500" ? 500 : 201,
          ),
        );
      await open();
      draft();
      review();
      confirm();
      await screen.findByText(/Resultado no confirmado/);
      fireEvent.click(screen.getByRole("button", { name: /^Mi perfil$/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Administración$/ }));
      expect(
        screen.getByRole("button", { name: "Revisar operación" }),
      ).toHaveProperty("disabled", true);
      fireEvent.change(screen.getByLabelText("UUID de usuario existente"), {
        target: { value: id(4) },
      });
      expect(screen.queryByText(/Resultado no confirmado/)).toBeNull();
      review();
      confirm();
      await screen.findByText(/Operación confirmada/);
      fireEvent.change(screen.getByLabelText("UUID de usuario existente"), {
        target: { value: target },
      });
      await screen.findByText(/Resultado no confirmado/);
      expect(api.writes).toHaveBeenCalledTimes(2);
    },
  );
  it("revalidates capability from the current profile before dispatch and removes revoked actions", async () => {
    const api = http();
    await open();
    draft();
    review();
    api.setProfile({ ...api.getProfile(), isPlatformAdministrator: false });
    confirm();
    await screen.findByText(/Ya no tienes permisos administrativos/);
    expect(api.writes).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("UUID de usuario existente")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Administración$/ }),
    ).toBeNull();
    expect(api.discovery).toHaveBeenCalledTimes(1);
  });
  it.each(["401", "different-actor"])(
    "invalidates instead of adopting %s during preflight",
    async (failure) => {
      const api = http();
      await open();
      draft();
      review();
      api.reads.mockResolvedValueOnce(
        failure === "401"
          ? json({}, 401)
          : json({ profile: { ...api.getProfile(), id: id(9) } }),
      );
      confirm();
      await screen.findByRole("button", { name: "Iniciar sesión" });
      expect(api.writes).not.toHaveBeenCalled();
    },
  );
  it("keeps a confirmed receipt when refresh fails and retries only GET reads", async () => {
    const api = http();
    await open();
    draft();
    review();
    api.reads
      .mockImplementationOnce(async () => json({ profile: api.getProfile() }))
      .mockRejectedValueOnce(new Error("refresh failed"));
    confirm();
    await screen.findByText(/Operación confirmada.*No fue posible actualizar/);
    expect(
      screen.getByRole("button", { name: "Revisar operación" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(
      screen.getByRole("button", { name: "Reintentar solo lecturas" }),
    );
    await screen.findByText(/Operación confirmada.*Lecturas actualizadas/);
    expect(api.writes).toHaveBeenCalledTimes(1);
  });
  it("refreshes self removal from the real profile and clears the revoked workspace without falling back", async () => {
    const api = http(true, "ADMIN");
    await open();
    draft("DELETE", api.getProfile().id);
    review();
    api.writes.mockImplementationOnce(async () => {
      api.setProfile({ ...api.getProfile(), memberships: [] });
      return new Response(null, { status: 204 });
    });
    confirm();
    await screen.findByText(/Operación confirmada/);
    expect(dashboardContext().textContent).toContain(
      "Elige una organización o grupo para empezar.",
    );
    fireEvent.click(
      within(screen.getByRole("navigation")).getByRole("button", {
        name: "Administración",
      }),
    );
    expect(screen.getByLabelText("UUID de usuario existente")).toBeTruthy();
  });
  it("retains an unknown lock after failed logout but resets after a legitimate new same-user login", async () => {
    const api = http();
    api.writes.mockRejectedValueOnce(new Error("unknown"));
    await open();
    draft();
    review();
    confirm();
    await screen.findByText(/Resultado no confirmado/);
    api.logout.mockRejectedValueOnce(new Error("failed logout"));
    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByText(/No fue posible cerrar la sesión/);
    expect(
      screen.getByRole("button", { name: "Revisar operación" }),
    ).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("button", { name: "Iniciar sesión" });
    fireEvent.change(screen.getByLabelText("RUT"), {
      target: { value: "123456785" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "synthetic-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /^Administración$/ }),
    );
    draft();
    expect(
      screen.getByRole("button", { name: "Revisar operación" }),
    ).toHaveProperty("disabled", false);
    expect(screen.queryByText(/Resultado no confirmado/)).toBeNull();
  });
  it.each(["401", "body"])(
    "ignores old mutation %s after logout and a new session",
    async (outcome) => {
      const api = http();
      const response = deferred<Response>();
      const body = deferred<unknown>();
      const old = json({});
      const parse = vi.spyOn(old, "json").mockReturnValue(body.promise);
      api.writes.mockReturnValueOnce(
        outcome === "body" ? Promise.resolve(old) : response.promise,
      );
      await open();
      draft();
      review();
      confirm();
      await waitFor(() => expect(api.writes).toHaveBeenCalledTimes(1));
      if (outcome === "body")
        await waitFor(() => expect(parse).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "Salir" }));
      await screen.findByRole("button", { name: "Iniciar sesión" });
      api.setProfile({ ...api.getProfile(), id: id(9), name: "Persona B" });
      fireEvent.change(screen.getByLabelText("RUT"), {
        target: { value: "123456785" },
      });
      fireEvent.change(screen.getByLabelText("Contraseña"), {
        target: { value: "synthetic-password" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
      fireEvent.click(
        await screen.findByRole("button", { name: /^Administración$/ }),
      );
      draft();
      await act(async () => {
        if (outcome === "body")
          body.resolve({
            membership: {
              userId: target,
              organizationId: org.id,
              role: "USER",
            },
          });
        else response.resolve(json({}, 401));
      });
      expect(screen.getByRole("navigation")).toBeTruthy();
      expect(screen.queryByText(/Operación confirmada/)).toBeNull();
      expect(
        screen.getByRole("button", { name: "Revisar operación" }),
      ).toHaveProperty("disabled", false);
    },
  );
  it("retains a dispatched pending intent as unknown after failed logout and ignores its late 401", async () => {
    const api = http();
    const response = deferred<Response>();
    api.writes.mockReturnValueOnce(response.promise);
    await open();
    draft();
    review();
    confirm();
    await waitFor(() => expect(api.writes).toHaveBeenCalledTimes(1));
    api.logout.mockRejectedValueOnce(new Error("failed logout"));
    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByText(/No fue posible cerrar la sesión/);
    await screen.findByText(/Resultado no confirmado/);
    await act(async () => response.resolve(json({}, 401)));
    expect(screen.getByRole("navigation")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Revisar operación" }),
    ).toHaveProperty("disabled", true);
    expect(api.writes).toHaveBeenCalledTimes(1);
  });
  it("cannot adopt a late preflight profile body into a new actor session", async () => {
    const api = http();
    await open();
    draft();
    review();
    const body = deferred<unknown>();
    const response = json({});
    const parse = vi.spyOn(response, "json").mockReturnValue(body.promise);
    api.reads.mockResolvedValueOnce(response);
    confirm();
    await waitFor(() => expect(parse).toHaveBeenCalledOnce());
    const oldProfile = api.getProfile();
    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("button", { name: "Iniciar sesión" });
    api.setProfile({
      ...oldProfile,
      id: id(9),
      name: "Persona B",
      isPlatformAdministrator: false,
      memberships: [],
    });
    fireEvent.change(screen.getByLabelText("RUT"), {
      target: { value: "123456785" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "synthetic-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    await screen.findByText(/Bienvenido, Persona B/);
    await act(async () => body.resolve({ profile: oldProfile }));
    expect(screen.getByText(/Bienvenido, Persona B/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^Administración$/ }),
    ).toBeNull();
    expect(api.writes).not.toHaveBeenCalled();
  });
  it("expires the current session on a current mutation 401", async () => {
    const api = http();
    api.writes.mockResolvedValueOnce(json({}, 401));
    await open();
    draft();
    review();
    confirm();
    await screen.findByRole("button", { name: "Iniciar sesión" });
    expect(screen.queryByRole("navigation")).toBeNull();
  });
  it("sends the exact ADMIN enum rather than a translated role label", async () => {
    const api = http();
    await open();
    draft("PATCH");
    fireEvent.change(screen.getByLabelText("Rol deseado"), {
      target: { value: "ADMIN" },
    });
    review();
    confirm();
    await screen.findByText(/Operación confirmada/);
    expect(api.writes.mock.calls[0][1].body).toBe(
      JSON.stringify({ role: "ADMIN" }),
    );
    expect(api.getProfile().memberships[0].role).toBe("USER");
  });
  it("does not clear target B's pending lock with target A's late body after failed logout", async () => {
    const api = http();
    const body = deferred<unknown>();
    const old = json({});
    const parse = vi.spyOn(old, "json").mockReturnValue(body.promise);
    api.writes.mockResolvedValueOnce(old);
    await open();
    draft();
    review();
    confirm();
    await waitFor(() => expect(parse).toHaveBeenCalledOnce());
    api.logout.mockRejectedValueOnce(new Error("failed logout"));
    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByText(/No fue posible cerrar la sesión/);
    fireEvent.change(screen.getByLabelText("UUID de usuario existente"), {
      target: { value: id(4) },
    });
    const next = deferred<Response>();
    api.writes.mockReturnValueOnce(next.promise);
    review();
    confirm();
    await waitFor(() => expect(api.writes).toHaveBeenCalledTimes(2));
    await act(async () =>
      body.resolve({
        membership: { organizationId: org.id, userId: target, role: "USER" },
      }),
    );
    expect(
      screen.getByRole("button", { name: "Revisar operación" }),
    ).toHaveProperty("disabled", true);
    expect(screen.queryByText(/Operación confirmada/)).toBeNull();
    await act(async () =>
      next.resolve(
        json(
          {
            membership: {
              organizationId: org.id,
              userId: id(4),
              role: "USER",
            },
          },
          201,
        ),
      ),
    );
    await screen.findByText(/Operación confirmada/);
    fireEvent.change(screen.getByLabelText("UUID de usuario existente"), {
      target: { value: target },
    });
    await screen.findByText(/Resultado no confirmado/);
  });
  it("preserves the unrelated policy operation ledger through a same-actor self-membership refresh", async () => {
    const api = http(true, "ADMIN");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^Políticas$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Editar v1" }));
    fireEvent.change(
      screen.getByLabelText("Umbral de revisión manual (0 a 1)"),
      { target: { value: "1" } },
    );
    fireEvent.submit(screen.getByRole("form", { name: "Editar política" }));
    await screen.findByText(/resultado es desconocido/i);
    fireEvent.click(screen.getByRole("button", { name: /^Administración$/ }));
    draft("PATCH", api.getProfile().id);
    review();
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
    confirm();
    await screen.findByText(/Operación confirmada/);
    fireEvent.click(screen.getByRole("button", { name: /^Políticas$/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Editar v1" }));
    await screen.findByText(/resultado es desconocido/i);
    expect(
      screen.getByLabelText("Umbral de revisión manual (0 a 1)"),
    ).toHaveProperty("value", "1");
    expect(api.policyWrite).toHaveBeenCalledTimes(1);
  });
});
