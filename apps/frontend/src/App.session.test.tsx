import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./features/resources/MlflowResources", () => ({
  MlflowResources: () => null,
}));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function profile(id: string, admin = false) {
  return {
    id,
    name: `Person ${id}`,
    rut: "123456785",
    email: `${id}@example.test`,
    username: id,
    isPlatformAdministrator: admin,
    memberships: [
      {
        organization: { id: `org-${id}`, name: `Organization ${id}`, slug: id },
        role: "ADMIN",
      },
    ],
  };
}
function group(id: string) {
  return {
    id: `group-${id}`,
    name: `Group ${id}`,
    description: null,
    organization: { id: `org-${id}`, name: `Organization ${id}` },
    members: [],
  };
}
function http(admin = false) {
  let identity = "A";
  const patch = vi
    .fn<() => Promise<Response>>()
    .mockResolvedValue(json({ profile: profile("A", admin) }));
  const mutation = vi.fn<() => Promise<Response>>().mockResolvedValue(json({}));
  const groups = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ groups: [group(identity)] }));
  const discovery = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () =>
      json({
        organizations: [
          {
            id: `org-${identity}`,
            name: `Organization ${identity}`,
            groups: [group(identity)],
          },
        ],
      }),
    );
  const logout = vi
    .fn<() => Promise<Response>>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  const getProfile = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () =>
      json({ profile: profile(identity, admin && identity === "A") }),
    );
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const path = input.toString();
      if (path === "/profile")
        return init?.method === "PATCH" ? patch() : getProfile();
      if (path === "/auth/logout") return logout();
      if (path === "/auth/login") {
        identity = "B";
        return json({ user: { id: "B" } });
      }
      if (path === "/groups") return groups();
      if (path === "/platform/organizations") return discovery();
      if (path.startsWith("/organizations/")) return mutation();
      if (path.startsWith("/resources?")) return json({ resources: [] });
      if (path.startsWith("/invoices?"))
        return json({ invoices: [], nextCursor: null });
      throw new Error(`Unexpected request: ${path}`);
    });
  return { patch, mutation, groups, discovery, logout, getProfile, fetchMock };
}
async function start() {
  const view = render(<App />);
  await screen.findByText("Group A");
  return view;
}
async function signOut() {
  fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
  await screen.findByRole("button", { name: "Iniciar sesión" });
}
async function signInB() {
  fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
    target: { value: "123456785" },
  });
  fireEvent.change(screen.getByLabelText("Contraseña"), {
    target: { value: "test-password-123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
  await screen.findByText("Group B");
}
function expectB() {
  expect(screen.getByText("Person B")).toBeTruthy();
  expect(screen.queryByText("Person A")).toBeNull();
  expect(screen.queryByText("Group A")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Guardar cambios" }),
  ).toHaveProperty("disabled", false);
  expect(screen.getByRole("button", { name: "Guardar grupo" })).toHaveProperty(
    "disabled",
    false,
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CR-001 mounted session isolation", () => {
  it("does not resurrect A after PATCH A, logout, late PATCH success", async () => {
    const api = http();
    const pending = deferred();
    api.patch.mockReturnValueOnce(pending.promise);
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await signOut();
    await act(async () => pending.resolve(json({ profile: profile("A") })));
    expect(screen.getByRole("button", { name: "Iniciar sesión" })).toBeTruthy();
    expect(screen.queryByText("Person A")).toBeNull();
  });

  it.each([200, 401, 500, "network"] as const)(
    "preserves B and its resource/invoice context after late PATCH A %s",
    async (status) => {
      const api = http();
      const pending = deferred();
      api.patch.mockReturnValueOnce(pending.promise);
      await start();
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      await signOut();
      const boundary = api.fetchMock.mock.calls.length;
      await signInB();
      await act(async () => {
        if (status === "network") pending.reject(new Error("Old failure"));
        else pending.resolve(json({ profile: profile("A") }, status));
      });
      expectB();
      fireEvent.click(screen.getByRole("button", { name: "Ver facturas" }));
      await waitFor(() =>
        expect(
          api.fetchMock.mock.calls.some(([path]) =>
            path.toString().startsWith("/invoices?"),
          ),
        ).toBe(true),
      );
      const protectedPaths = api.fetchMock.mock.calls
        .slice(boundary)
        .filter(([path]) => /^\/(resources|invoices)\?/.test(path.toString()))
        .map(([path]) => new URL(path.toString(), "http://test.invalid"));
      expect(
        protectedPaths.some((url) => url.searchParams.get("ownerId") === "B"),
      ).toBe(true);
      expect(new Set(protectedPaths.map((url) => url.pathname))).toEqual(
        new Set(["/resources", "/invoices"]),
      );
      for (const [path] of api.fetchMock.mock.calls.slice(boundary)) {
        if (/^\/(resources|invoices)\?/.test(path.toString())) {
          const url = new URL(path.toString(), "http://test.invalid");
          expect(url.searchParams.get("ownerId")).toBe("B");
          expect(url.searchParams.get("organizationId")).toBe("org-B");
        }
      }
      expect(screen.queryByRole("option", { name: /Group A/ })).toBeNull();
      expect(screen.getAllByRole("option", { name: /Group B/ })).toHaveLength(
        2,
      );
    },
  );

  it.each([200, 401, 500])(
    "ignores stale group mutation %s, including its reload and finally",
    async (status) => {
      const api = http();
      const pending = deferred();
      api.mutation.mockReturnValueOnce(pending.promise);
      await start();
      fireEvent.click(
        screen.getByRole("button", { name: "Eliminar grupo Group A" }),
      );
      await signOut();
      await signInB();
      const count = api.groups.mock.calls.length;
      await act(async () => pending.resolve(json({}, status)));
      expectB();
      expect(api.groups).toHaveBeenCalledTimes(count);
    },
  );

  it.each([200, 401, 500])(
    "does not publish stale group reload %s into B",
    async (status) => {
      const api = http();
      const pending = deferred();
      await start();
      api.groups.mockReturnValueOnce(pending.promise);
      fireEvent.click(
        screen.getByRole("button", { name: "Eliminar grupo Group A" }),
      );
      await waitFor(() => expect(api.groups).toHaveBeenCalledTimes(2));
      await signOut();
      await signInB();
      await act(async () =>
        pending.resolve(json({ groups: [group("A")] }, status)),
      );
      expectB();
      expect(screen.getByText("Group B")).toBeTruthy();
      expect(screen.queryByRole("option", { name: /Group A/ })).toBeNull();
    },
  );

  it("checks identity again after a delayed PATCH response body", async () => {
    const api = http();
    let completeBody!: (value: unknown) => void;
    const response = json({});
    const body = vi.spyOn(response, "json").mockReturnValue(
      new Promise<unknown>((resolve) => {
        completeBody = resolve;
      }),
    );
    api.patch.mockResolvedValueOnce(response);
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(body).toHaveBeenCalledTimes(1));
    await signOut();
    await signInB();
    await act(async () => completeBody({ profile: profile("A") }));
    expectB();
  });

  it("does not let A's stale finally release B's pending save flag", async () => {
    const api = http();
    const old = deferred();
    const current = deferred();
    api.patch
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await signOut();
    await signInB();
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await act(async () => old.resolve(json({}, 500)));
    expect(
      screen.getByRole("button", { name: "Guardando cambios..." }),
    ).toHaveProperty("disabled", true);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => current.resolve(json({ profile: profile("B") })));
    expectB();
    expect(screen.getByText("Perfil actualizado.")).toBeTruthy();
  });

  it("does not continue a stale discovery reload with another identity's groups", async () => {
    const api = http(true);
    const pending = deferred();
    await start();
    api.discovery.mockReturnValueOnce(pending.promise);
    fireEvent.click(
      screen.getByRole("button", { name: "Eliminar grupo Group A" }),
    );
    await waitFor(() => expect(api.discovery).toHaveBeenCalledTimes(2));
    await signOut();
    await signInB();
    const count = api.groups.mock.calls.length;
    await act(async () =>
      pending.resolve(
        json({
          organizations: [
            { id: "org-A", name: "Old discovery", groups: [group("A")] },
          ],
        }),
      ),
    );
    expectB();
    expect(api.groups).toHaveBeenCalledTimes(count);
    expect(screen.queryByText("Old discovery")).toBeNull();
  });

  it("invalidates pending profile work at logout start even when logout fails", async () => {
    const api = http();
    const pending = deferred();
    const logout = deferred();
    api.patch.mockReturnValueOnce(pending.promise);
    api.logout.mockReturnValueOnce(logout.promise);
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await act(async () =>
      pending.resolve(
        json({ profile: { ...profile("A"), name: "Stale update" } }),
      ),
    );
    expect(screen.queryByText("Stale update")).toBeNull();
    await act(async () => logout.resolve(json({}, 500)));
    expect(screen.getByText("Person A")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "No fue posible cerrar",
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await screen.findByText("Perfil actualizado.");
  });

  it("does not issue dependent reload work after unmount", async () => {
    const api = http();
    const pending = deferred();
    api.mutation.mockReturnValueOnce(pending.promise);
    const view = await start();
    fireEvent.click(
      screen.getByRole("button", { name: "Eliminar grupo Group A" }),
    );
    const count = api.fetchMock.mock.calls.length;
    view.unmount();
    await act(async () => pending.resolve(json({})));
    expect(api.fetchMock).toHaveBeenCalledTimes(count);
  });

  it.each([401, 500])(
    "handles authoritative profile %s after login without protected work and permits retry",
    async (status) => {
      const api = http();
      api.getProfile
        .mockResolvedValueOnce(json({}, 401))
        .mockResolvedValueOnce(json({}, status));
      render(<App />);
      await screen.findByRole("button", { name: "Iniciar sesión" });
      fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
        target: { value: "123456785" },
      });
      fireEvent.change(screen.getByLabelText("Contraseña"), {
        target: { value: "test-password-123" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
      if (status === 401)
        await screen.findByRole("button", { name: "Iniciar sesión" });
      else await screen.findByText("No fue posible cargar el perfil.");
      expect(api.groups).not.toHaveBeenCalled();
      expect(api.discovery).not.toHaveBeenCalled();
      if (status === 401) await signInB();
      else {
        fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
        await screen.findByText("Group B");
      }
      expectB();
    },
  );
});
