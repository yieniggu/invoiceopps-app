import { namedId } from "./test/ids";
import { NO_PERMISSIONS } from "./test/transport";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  orgKey,
  orgGroupsKey,
  workspaceGroupsKey,
} from "./features/auth/session/queryKeys";
import { renderApp } from "./test/renderApp";
import { uuid } from "./test/ids";

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
        organization: {
          id: namedId("org", id),
          name: `Organization ${id}`,
          slug: id,
        },
        role: "ADMIN",
        // The inbox offers what the profile can read: the organization and the
        // group of this person.
        permissions: { ...NO_PERMISSIONS, readInvoices: true },
        groups: [
          {
            group: { id: namedId("group", id), name: `Group ${id}` },
            permissions: NO_PERMISSIONS,
            effective: { ...NO_PERMISSIONS, readInvoices: true },
          },
        ],
      },
    ],
  };
}
function group(id: string) {
  return {
    id: namedId("group", id),
    name: `Group ${id}`,
    description: null,
    organization: { id: namedId("org", id), name: `Organization ${id}` },
    members: [],
  };
}
// Organization-scoped shape behind the Grupos screens.
function scopedGroup(id: string) {
  return {
    id: namedId("group", id),
    organizationId: namedId("org", id),
    name: `Group ${id}`,
    description: null,
  };
}
// v2: permissions live on each member of the group, not on the group.
function groupMember(id: string) {
  return {
    userId: uuid(id.charCodeAt(0)),
    groupId: namedId("group", id),
    organizationId: namedId("org", id),
    permissions: NO_PERMISSIONS,
    user: {
      id: uuid(id.charCodeAt(0)),
      name: `Member ${id}`,
      rut: "190347907",
    },
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
  const orgGroups = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () => json({ groups: [scopedGroup(identity)] }));
  const discovery = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () =>
      json({
        page: 1,
        pageSize: 20,
        total: 1,
        organizations: [
          {
            id: namedId("org", identity),
            name: `Organization ${identity}`,
            slug: `listed-${identity.toLowerCase()}`,
            description: `Descripción ${identity}`,
            enabled: true,
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      }),
    );
  // Summary behind the organization screen (data and counts in one read).
  const summary = vi
    .fn<() => Promise<Response>>()
    .mockImplementation(async () =>
      json({
        organization: {
          id: namedId("org", identity),
          name: `Organization ${identity}`,
          slug: identity,
          description: `Descripción ${identity}`,
        },
        summary: { memberCount: 1, groupCount: 1 },
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
      if (path.split("?")[0] === "/api/v1/organizations") return discovery();
      if (
        /^\/api\/v1\/organizations\/00000000-0000-4000-9000-[0-9a-f]{12}$/.test(
          path,
        ) &&
        (init?.method ?? "GET") === "GET"
      )
        return summary();
      if (
        /^\/api\/v1\/organizations\/[^/]+\/groups$/.test(path) &&
        (init?.method ?? "GET") === "GET"
      )
        return orgGroups();
      const members =
        /^\/api\/v1\/organizations\/(00000000-0000-4000-9000-[0-9a-f]{12})\/groups\/00000000-0000-4000-a000-[0-9a-f]{12}\/memberships(?:\?.*)?$/.exec(
          path,
        );
      if (members && (init?.method ?? "GET") === "GET")
        return json({
          memberships: [
            groupMember(
              ["A", "B"].find((id) => namedId("org", id) === members[1])!,
            ),
          ],
          page: 1,
          pageSize: 100,
          total: 1,
        });
      // The group detail also reads its members; only writes count as mutations.
      if (path.startsWith("/api/v1/organizations/"))
        return (init?.method ?? "GET") === "GET"
          ? json({
              memberships: [],
              users: [],
              page: 1,
              pageSize: 100,
              total: 0,
            })
          : mutation();
      if (path.startsWith("/api/v1/invoices?"))
        return json({ items: [], page: 1, pageSize: 20, total: 0 });
      throw new Error(`Unexpected request: ${path}`);
    });
  return {
    patch,
    mutation,
    groups,
    orgGroups,
    discovery,
    summary,
    logout,
    getProfile,
    fetchMock,
  };
}
async function start() {
  const view = renderApp();
  fireEvent.click(await screen.findByRole("link", { name: "Grupos" }));
  await screen.findByText("Group A");
  navigate("Mi perfil");
  return view;
}
/** Revalidates one Query entry of identity A, as a mutation or retry would. */
function reload(
  view: ReturnType<typeof renderApp>,
  queryKey: readonly unknown[],
) {
  act(() => {
    void view.store
      .getSnapshot()
      .client.invalidateQueries({ queryKey, exact: true });
  });
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
  fireEvent.click(await screen.findByRole("link", { name: "Grupos" }));
  await screen.findByText("Group B");
  navigate("Mi perfil");
}
function navigate(name: string) {
  fireEvent.click(screen.getByRole("link", { name }));
}
/** The group summary, reached from the list. */
function openGroup(id: string) {
  fireEvent.click(screen.getByRole("link", { name: `Ver grupo Group ${id}` }));
}
/**
 * Edits the group member's flags and saves them (PUT, a mutation here). The
 * editor lives on the person's page: Miembros, then the person.
 */
async function savePermissions(id: string) {
  fireEvent.click(await screen.findByRole("link", { name: "Miembros" }));
  fireEvent.click(await screen.findByRole("link", { name: `Member ${id}` }));
  const editor = await screen.findByRole("group", {
    name: `Permisos en el grupo «Group ${id}» — Member ${id}`,
  });
  fireEvent.click(
    within(editor).getByRole("button", { name: "Leer facturas" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: `Guardar permisos de Member ${id}` }),
  );
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
  navigate("Grupos");
  expect(screen.getByText("Group B")).toBeTruthy();
  expect(screen.queryByText("Group A")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  openGroup("B");
  expect(
    screen.getByRole("heading", { name: "Group B", level: 1 }),
  ).toBeTruthy();
  navigate("Mi perfil");
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Api = ReturnType<typeof http>;
interface ReadCase {
  label: string;
  admin: boolean;
  read: (api: Api) => ReturnType<typeof vi.fn<() => Promise<Response>>>;
  /** Destination whose screen issues the read; null = loaded with the session. */
  destination: string | null;
  key: readonly unknown[];
  failure: string;
  retry: string;
  /** Resolves once the read's data is on screen. */
  expectLoaded: () => Promise<unknown>;
  /** Extra navigation from the destination to the screen that reads. */
  drillDown?: string;
}

const showsText = (text: string) => () => screen.findByText(text);

const cases: ReadCase[] = [
  {
    label: "workspace groups",
    admin: false,
    read: (api) => api.groups,
    destination: "Grupos",
    key: workspaceGroupsKey("A"),
    failure: "No fue posible validar tu espacio de trabajo.",
    retry: "Reintentar espacio de trabajo",
    expectLoaded: showsText("Group A"),
  },
  {
    label: "organization groups",
    admin: false,
    read: (api) => api.orgGroups,
    destination: "Grupos",
    key: orgGroupsKey("A", "00000000-0000-4000-9000-f9e9c6048aeb"),
    failure: "No fue posible cargar los grupos.",
    retry: "Reintentar grupos",
    expectLoaded: showsText("Group A"),
  },
  {
    label: "organization summary",
    admin: false,
    read: (api) => api.summary,
    destination: "Organizaciones",
    // The organization screen reads its own summary (data and counts).
    drillDown: "Ver detalle de Organization A",
    key: orgKey("A", "00000000-0000-4000-9000-f9e9c6048aeb"),
    failure: "No fue posible cargar la información de la organización.",
    retry: "Reintentar organización",
    expectLoaded: showsText("Descripción A"),
  },
];

async function open(testCase: ReadCase) {
  if (testCase.destination)
    fireEvent.click(
      await screen.findByRole("link", { name: testCase.destination }),
    );
  if (testCase.drillDown)
    fireEvent.click(
      await screen.findByRole("link", { name: testCase.drillDown }),
    );
}

describe("CR007 App-owned protected reads", () => {
  for (const testCase of cases) {
    for (const phase of ["initial", "reload"] as const) {
      /** Starts the pending read for the phase and waits until it is in flight. */
      async function launch(api: Api, pending: ReturnType<typeof deferred>) {
        const read = testCase.read(api);
        const view = renderApp();
        if (phase === "reload") {
          await open(testCase);
          await testCase.expectLoaded();
          read.mockReturnValueOnce(pending.promise);
          reload(view, testCase.key);
        } else {
          read.mockReturnValueOnce(pending.promise);
          await open(testCase);
        }
        await waitFor(() =>
          expect(read).toHaveBeenCalledTimes(phase === "initial" ? 1 : 2),
        );
        return { read, view };
      }

      it(`expires the current session on ${phase} ${testCase.label} 401`, async () => {
        const api = http(testCase.admin);
        const pending = deferred();
        const { read } = await launch(api, pending);
        expect(screen.getByRole("button", { name: "Salir" })).toBeTruthy();
        const reads = read.mock.calls.length;
        await act(async () => pending.resolve(json({}, 401)));
        expect(
          await screen.findByRole("button", { name: "Iniciar sesión" }),
        ).toBeTruthy();
        expect(screen.queryByRole("navigation")).toBeNull();
        expect(screen.queryByRole("button", { name: "Salir" })).toBeNull();
        expect(read).toHaveBeenCalledTimes(reads);
        expect(api.logout).not.toHaveBeenCalled();
      });

      it(`ignores a late ${phase} ${testCase.label} 401 after login B`, async () => {
        const api = http(testCase.admin);
        const pending = deferred();
        await launch(api, pending);
        await signOut();
        await signInB();
        const count = api.fetchMock.mock.calls.length;
        await act(async () => pending.resolve(json({}, 401)));
        // The late answer of A starts no request of its own...
        expect(api.fetchMock).toHaveBeenCalledTimes(count);
        // ...and leaves B untouched (re-opening a screen may refetch by itself).
        expectB();
      });
    }

    it.each(["body", "error"])(
      `ignores delayed initial ${testCase.label} JSON %s after login B`,
      async (outcome) => {
        const api = http(testCase.admin);
        const read = testCase.read(api);
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
        renderApp();
        await open(testCase);
        await waitFor(() => expect(parse).toHaveBeenCalledTimes(1));
        await signOut();
        await signInB();
        const count = api.fetchMock.mock.calls.length;
        await act(async () => {
          if (outcome === "error") reject(new Error("Old JSON failure"));
          else
            resolve(
              testCase.label === "organization summary"
                ? {
                    organization: {
                      id: "00000000-0000-4000-9000-f9e9c6048aeb",
                      name: "Organization A",
                      slug: "A",
                      description: "Descripción A",
                    },
                    summary: { memberCount: 1, groupCount: 1 },
                  }
                : testCase.label === "workspace groups"
                  ? { groups: [group("A")] }
                  : { groups: [scopedGroup("A")] },
            );
        });
        expect(api.fetchMock).toHaveBeenCalledTimes(count);
        expectB();
      },
    );

    it.each([403, 404, 500])(
      `retains session and retry for ${testCase.label} HTTP %s`,
      async (status) => {
        const api = http(testCase.admin);
        const read = testCase.read(api);
        read.mockResolvedValueOnce(json({}, status));
        renderApp();
        await open(testCase);
        const retry = await screen.findByRole("button", {
          name: testCase.retry,
        });
        expect((await screen.findByRole("alert")).textContent).toContain(
          testCase.failure,
        );
        expect(screen.getByRole("button", { name: "Salir" })).toBeTruthy();
        fireEvent.click(retry);
        await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        await testCase.expectLoaded();
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
        expect(api.logout).not.toHaveBeenCalled();
      },
    );
  }

  it("does not launch protected discovery or groups for an anonymous profile", async () => {
    const api = http(true);
    api.getProfile.mockResolvedValueOnce(json({}, 401));
    renderApp();
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
      fireEvent.change(screen.getByLabelText("Ver facturas de"), {
        target: {
          value: `group:${namedId("org", "A")}:${namedId("group", "A")}`,
        },
      });
      await waitFor(() =>
        expect(
          api.fetchMock.mock.calls.some(([path]) =>
            path.toString().includes(`groupId=${namedId("group", "A")}`),
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
          api.fetchMock.mock.calls
            .slice(boundary)
            .some(([path]) => path.toString().startsWith("/api/v1/invoices?")),
        ).toBe(true),
      );
      const invoiceReads = api.fetchMock.mock.calls
        .slice(boundary)
        .filter(([path]) => /^\/api\/v1\/invoices\?/.test(path.toString()))
        .map(([path]) => new URL(path.toString(), "http://test.invalid"));
      expect(new Set(invoiceReads.map((url) => url.pathname))).toEqual(
        new Set(["/api/v1/invoices"]),
      );
      // B reads only B's organization, and never A's group.
      for (const url of invoiceReads) {
        expect(url.searchParams.get("organizationId")).toBe(
          namedId("org", "B"),
        );
        expect(url.searchParams.get("groupId")).not.toBe(namedId("group", "A"));
      }
      expect(screen.queryByRole("option", { name: /Group A/ })).toBeNull();
      expect(screen.getAllByRole("option", { name: /Group B/ })).toHaveLength(
        1,
      );
    },
  );

  it.each([200, 401, 500])(
    "ignores stale group mutation %s, including its refresh",
    async (status) => {
      const api = http();
      const pending = deferred();
      api.mutation.mockReturnValueOnce(pending.promise);
      await start();
      navigate("Grupos");
      openGroup("A");
      await savePermissions("A");
      await waitFor(() => expect(api.mutation).toHaveBeenCalledTimes(1));
      await signOut();
      await signInB();
      const count = api.fetchMock.mock.calls.length;
      await act(async () => pending.resolve(json({}, status)));
      expect(api.fetchMock).toHaveBeenCalledTimes(count);
      expectB();
    },
  );

  it.each([200, 401, 500])(
    "does not publish stale workspace group reload %s into B",
    async (status) => {
      const api = http();
      const pending = deferred();
      const view = await start();
      api.groups.mockReturnValueOnce(pending.promise);
      reload(view, workspaceGroupsKey("A"));
      await waitFor(() => expect(api.groups).toHaveBeenCalledTimes(2));
      await signOut();
      await signInB();
      await act(async () =>
        pending.resolve(json({ groups: [group("A")] }, status)),
      );
      expectB();
      navigate("Grupos");
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
      await screen.findByRole("button", { name: "Guardando cambios..." }),
    ).toHaveProperty("disabled", true);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => current.resolve(json({ profile: profile("B") })));
    expect(await screen.findByText("Perfil actualizado.")).toBeTruthy();
    expectB();
  });

  it("does not continue a stale organization summary reload with another identity's data", async () => {
    const api = http(true);
    const pending = deferred();
    const view = await start();
    navigate("Organizaciones");
    fireEvent.click(
      await screen.findByRole("link", {
        name: "Ver detalle de Organization A",
      }),
    );
    await screen.findByText("Descripción A");
    api.summary.mockReturnValueOnce(pending.promise);
    reload(view, orgKey("A", "00000000-0000-4000-9000-f9e9c6048aeb"));
    await waitFor(() => expect(api.summary).toHaveBeenCalledTimes(2));
    await signOut();
    await signInB();
    const count = api.groups.mock.calls.length;
    await act(async () =>
      pending.resolve(
        json({
          organization: {
            id: "00000000-0000-4000-9000-f9e9c6048aeb",
            name: "Old summary",
            slug: "old-summary",
            description: "Old description",
          },
          summary: { memberCount: 9, groupCount: 9 },
        }),
      ),
    );
    expect(api.groups).toHaveBeenCalledTimes(count);
    expect(screen.queryByText("old-summary")).toBeNull();
    expect(screen.queryByText("Old description")).toBeNull();
    expectB();
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
    expect(await screen.findByText("Person A")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toContain(
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
    navigate("Grupos");
    openGroup("A");
    await savePermissions("A");
    await waitFor(() => expect(api.mutation).toHaveBeenCalledTimes(1));
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
      renderApp();
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
          await screen.findByRole("link", {
            name: "Grupos",
          }),
        );
        await screen.findByText("Group B");
      }
      expectB();
    },
  );
});
