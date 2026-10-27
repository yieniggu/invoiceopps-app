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
    rut: "12345678-5",
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
      if (path === "/api/v1/auth/profile" || path === "/api/v1/profile")
        return init?.method === "PATCH" ? patch() : getProfile();
      if (path === "/api/v1/auth/logout") return logout();
      if (path === "/api/v1/auth/login") {
        identity = "B";
        return json({ user: { id: "B" } });
      }
      if (path === "/api/v1/groups") return groups();
      if (path === "/api/v1/platform/organizations") return discovery();
      if (path.startsWith("/api/v1/organizations/")) return mutation();
      if (path.startsWith("/api/v1/invoices?"))
        return json({ invoices: [], nextCursor: null });
      throw new Error(`Unexpected request: ${path}`);
    });
  return { patch, mutation, groups, discovery, logout, getProfile, fetchMock };
}
async function start() {
  const view = render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Mis grupos" }));
  await screen.findByText("Group A");
  navigate("Mi perfil");
  return view;
}
async function signOut() {
  fireEvent.click(screen.getByRole("button", { name: "Salir" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "Mis grupos" }));
  await screen.findByText("Group B");
  navigate("Mi perfil");
}
function navigate(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}
function expectB() {
  navigate("Mi perfil");
  expect(screen.getByText("Person B")).toBeTruthy();
  expect(screen.queryByText("Person A")).toBeNull();
  expect(screen.queryByText("Group A")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Guardar cambios" }),
  ).toHaveProperty("disabled", false);
  navigate("Mis grupos");
  expect(screen.getByText("Group B")).toBeTruthy();
  expect(screen.queryByText("Group A")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Guardar grupo Group B" }),
  ).toHaveProperty("disabled", false);
  navigate("Mi perfil");
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CR007 App-owned protected reads", () => {
  const cases = [
    { label: "member groups", admin: false, discovery: false },
    { label: "administrator groups", admin: true, discovery: false },
    { label: "administrator discovery", admin: true, discovery: true },
  ];

  for (const testCase of cases) {
    for (const phase of ["initial", "reload"] as const) {
      it(`expires the current session on ${phase} ${testCase.label} 401`, async () => {
        const api = http(testCase.admin);
        const read = testCase.discovery ? api.discovery : api.groups;
        const pending = deferred();
        if (phase === "reload") await start();
        read.mockReturnValueOnce(pending.promise);
        if (phase === "initial") render(<App />);
        else {
          navigate("Mis grupos");
          fireEvent.click(
            screen.getByRole("button", { name: "Eliminar grupo Group A" }),
          );
        }
        await waitFor(() =>
          expect(read).toHaveBeenCalledTimes(phase === "initial" ? 1 : 2),
        );
        expect(screen.getByRole("button", { name: "Salir" })).toBeTruthy();
        const groupReads = api.groups.mock.calls.length;
        await act(async () => pending.resolve(json({}, 401)));
        expect(
          await screen.findByRole("button", { name: "Iniciar sesión" }),
        ).toBeTruthy();
        expect(screen.queryByRole("navigation")).toBeNull();
        expect(screen.queryByRole("button", { name: "Salir" })).toBeNull();
        expect(api.groups).toHaveBeenCalledTimes(groupReads);
        expect(api.logout).not.toHaveBeenCalled();
      });

      it(`ignores a late ${phase} ${testCase.label} 401 after login B`, async () => {
        const api = http(testCase.admin);
        const read = testCase.discovery ? api.discovery : api.groups;
        const pending = deferred();
        if (phase === "reload") await start();
        read.mockReturnValueOnce(pending.promise);
        if (phase === "initial") render(<App />);
        else {
          navigate("Mis grupos");
          fireEvent.click(
            screen.getByRole("button", { name: "Eliminar grupo Group A" }),
          );
        }
        await waitFor(() =>
          expect(read).toHaveBeenCalledTimes(phase === "initial" ? 1 : 2),
        );
        await signOut();
        await signInB();
        const count = api.fetchMock.mock.calls.length;
        await act(async () => pending.resolve(json({}, 401)));
        expectB();
        expect(api.fetchMock).toHaveBeenCalledTimes(count);
      });
    }

    it.each(["body", "error"])(
      `ignores delayed initial ${testCase.label} JSON %s after login B`,
      async (outcome) => {
        const api = http(testCase.admin);
        const read = testCase.discovery ? api.discovery : api.groups;
        let resolve!: (value: unknown) => void;
        let reject!: (reason: Error) => void;
        const response = json({});
        const parse = vi.spyOn(response, "json").mockReturnValue(
          new Promise<unknown>((yes, no) => {
            resolve = yes;
            reject = no;
          }),
        );
        read.mockResolvedValueOnce(response);
        render(<App />);
        await waitFor(() => expect(parse).toHaveBeenCalledTimes(1));
        await signOut();
        await signInB();
        const count = api.fetchMock.mock.calls.length;
        await act(async () => {
          if (outcome === "error") reject(new Error("Old JSON failure"));
          else
            resolve(
              testCase.discovery
                ? {
                    organizations: [
                      {
                        id: "org-A",
                        name: "Old discovery",
                        groups: [group("A")],
                      },
                    ],
                  }
                : { groups: [group("A")] },
            );
        });
        expectB();
        expect(api.fetchMock).toHaveBeenCalledTimes(count);
      },
    );

    it.each([403, 404, 500])(
      `retains session and retry for ${testCase.label} HTTP %s`,
      async (status) => {
        const api = http(testCase.admin);
        const read = testCase.discovery ? api.discovery : api.groups;
        read.mockResolvedValueOnce(json({}, status));
        render(<App />);
        fireEvent.click(
          await screen.findByRole("button", {
            name: testCase.discovery ? "Organizaciones" : "Mis grupos",
          }),
        );
        const retry = await screen.findByRole("button", {
          name: testCase.discovery
            ? "Reintentar organizaciones"
            : "Reintentar grupos",
        });
        expect(screen.getByRole("alert").textContent).toContain(
          testCase.discovery
            ? "No fue posible cargar las organizaciones."
            : "No fue posible cargar los grupos.",
        );
        expect(screen.getByRole("button", { name: "Salir" })).toBeTruthy();
        fireEvent.click(retry);
        await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        await screen.findByText(
          testCase.discovery ? "Organization A" : "Group A",
        );
        expect(screen.queryByRole("alert")).toBeNull();
        expect(api.logout).not.toHaveBeenCalled();
      },
    );
  }

  it("does not launch protected discovery or groups for an anonymous profile", async () => {
    const api = http(true);
    api.getProfile.mockResolvedValueOnce(json({}, 401));
    render(<App />);
    await screen.findByRole("button", { name: "Iniciar sesión" });
    expect(api.getProfile).toHaveBeenCalledTimes(1);
    expect(api.discovery).not.toHaveBeenCalled();
    expect(api.groups).not.toHaveBeenCalled();
    expect(api.fetchMock).toHaveBeenCalledTimes(1);
  });
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
    "preserves B and its invoice context after late PATCH A %s",
    async (status) => {
      const api = http();
      const pending = deferred();
      api.patch.mockReturnValueOnce(pending.promise);
      await start();
      navigate("Facturas");
      fireEvent.change(screen.getByRole("combobox", { name: "Propietario" }), {
        target: { value: "org-A:group:group-A" },
      });
      await waitFor(() =>
        expect(
          api.fetchMock.mock.calls.some(([path]) =>
            path.toString().includes("ownerId=group-A"),
          ),
        ).toBe(true),
      );
      navigate("Mi perfil");
      fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
      await signOut();
      const boundary = api.fetchMock.mock.calls.length;
      await signInB();
      await act(async () => {
        if (status === "network") pending.reject(new Error("Old failure"));
        else pending.resolve(json({ profile: profile("A") }, status));
      });
      expectB();
      navigate("Facturas");
      expect(screen.getByRole("option", { name: /Group B/ })).toBeTruthy();
      await waitFor(() =>
        expect(
          api.fetchMock.mock.calls.some(([path]) =>
            path.toString().startsWith("/api/v1/invoices?"),
          ),
        ).toBe(true),
      );
      const protectedPaths = api.fetchMock.mock.calls
        .slice(boundary)
        .filter(([path]) => /^\/api\/v1\/invoices\?/.test(path.toString()))
        .map(([path]) => new URL(path.toString(), "http://test.invalid"));
      expect(
        protectedPaths.some((url) => url.searchParams.get("ownerId") === "B"),
      ).toBe(true);
      expect(new Set(protectedPaths.map((url) => url.pathname))).toEqual(
        new Set(["/api/v1/invoices"]),
      );
      for (const [path] of api.fetchMock.mock.calls.slice(boundary)) {
        if (/^\/api\/v1\/invoices\?/.test(path.toString())) {
          const url = new URL(path.toString(), "http://test.invalid");
          expect(url.searchParams.get("ownerId")).toBe("B");
          expect(url.searchParams.get("organizationId")).toBe("org-B");
        }
      }
      expect(screen.queryByRole("option", { name: /Group A/ })).toBeNull();
      expect(screen.getAllByRole("option", { name: /Group B/ })).toHaveLength(
        1,
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
      navigate("Mis grupos");
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
      navigate("Mis grupos");
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
      navigate("Mis grupos");
      expect(screen.getByText("Group B")).toBeTruthy();
      expect(screen.queryByText("Group A")).toBeNull();
      navigate("Facturas");
      expect(screen.queryByRole("option", { name: /Group A/ })).toBeNull();
      expect(screen.getByRole("option", { name: /Group B/ })).toBeTruthy();
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
    navigate("Mis grupos");
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
    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
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
    navigate("Mis grupos");
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
        fireEvent.click(
          await screen.findByRole("button", {
            name: "Mis grupos",
          }),
        );
        await screen.findByText("Group B");
      }
      expectB();
    },
  );
});
