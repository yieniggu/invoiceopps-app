import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "./test/renderApp";
import {
  errorResponse,
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const none = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};
const accounting = {
  id: "group-a",
  organizationId: "org-1",
  name: "Contabilidad",
  description: null,
};
const sales = {
  id: "group-b",
  organizationId: "org-1",
  name: "Ventas",
  description: "Equipo comercial",
};
const southGroup = {
  id: "group-c",
  organizationId: "org-2",
  name: "Operaciones",
  description: null,
};
const north = { id: "org-1", name: "Academia Norte" };
const south = { id: "org-2", name: "Instituto Sur" };
// The profile carries what each group membership effectively allows; the
// group catalogue itself carries no permissions (v2).
const admin = profileFixture({
  memberships: [
    membership(north, "ADMIN", {
      groups: [
        {
          group: { id: "group-b", name: "Ventas" },
          effective: { ...none, readInvoices: true },
        },
      ],
    }),
    membership(south, "ADMIN", {
      groups: [{ group: { id: "group-c", name: "Operaciones" } }],
    }),
  ],
});
const carlaInGroup = (permissions = none, groupId = "group-a") => ({
  userId: "user-3",
  groupId,
  organizationId: "org-1",
  permissions,
  user: orgUsers[1],
});
const orgUsers = [
  { id: "user-1", name: "Ada Lovelace", rut: "123456785", role: "ADMIN" },
  { id: "user-3", name: "Carla Soto", rut: "190347907", role: "USER" },
];

function baseRoutes(groups: unknown[] = [accounting, sales]) {
  return {
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: admin }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations/org-1/groups": () => jsonResponse({ groups }),
    "GET /api/v1/organizations/org-2/groups": () =>
      jsonResponse({ groups: [southGroup] }),
    "GET /api/v1/organizations/org-1/users": () =>
      jsonResponse({ users: orgUsers }),
    "GET /api/v1/organizations/org-2/users": () => jsonResponse({ users: [] }),
  };
}

const DETAIL = "/organizations/org-1/groups";
const MEMBERS_A = "GET /api/v1/organizations/org-1/groups/group-a/memberships";
const PUT_CARLA =
  "PUT /api/v1/organizations/org-1/groups/group-a/memberships/user-3/permissions";
const BULK_PUT =
  "PUT /api/v1/organizations/org-1/groups/group-a/memberships/permissions";
const BULK_POST =
  "POST /api/v1/organizations/org-1/groups/group-a/memberships/bulk";
const adaInGroup = (permissions = none) => ({
  userId: "user-1",
  groupId: "group-a",
  organizationId: "org-1",
  permissions,
  user: orgUsers[0],
});

describe("group list and creation (AC-11)", () => {
  it("creates a group with name and optional description only and goes on to add its members", async () => {
    const groups = [accounting, sales];
    const transport = mockTransport({
      ...baseRoutes(groups),
      "GET /api/v1/organizations/org-1/groups/group-n/memberships": () =>
        jsonResponse({ memberships: [] }),
      "POST /api/v1/organizations/org-1/groups": () => {
        const created = { ...accounting, id: "group-n", name: "Cobranza" };
        groups.push(created);
        return jsonResponse({ group: created }, 201);
      },
    });
    renderApp({ route: `${DETAIL}/new` });
    // The form asks for the name and the description, never for people.
    expect(await screen.findByLabelText("Nombre del grupo")).toBeTruthy();
    expect(screen.getByLabelText("Descripción (opcional)")).toBeTruthy();
    expect(screen.queryByText(/Miembros iniciales/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Nombre del grupo"), {
      target: { value: "Cobranza" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear grupo" }));
    // Success lands on the add-members screen of the new group.
    await screen.findByText("Grupo creado. Agrega a sus miembros.");
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Agregar miembros al grupo",
      }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(`${DETAIL}/group-n/members/new`);
    expect(
      transport.calls("POST /api/v1/organizations/org-1/groups")[0].body,
    ).toEqual({
      name: "Cobranza",
    });
    // No member was chosen: no further write is made.
    expect(
      transport.requests.filter(
        ({ method, path }) =>
          method !== "GET" && path !== "/api/v1/organizations/org-1/groups",
      ),
    ).toEqual([]);
    // The list is read after the write, so the new group is what the screen shows.
    const post = transport.requests.findIndex(
      ({ method }) => method === "POST",
    );
    const reread = transport.requests.findIndex(
      ({ method, path }, index) =>
        index > post &&
        method === "GET" &&
        path === "/api/v1/organizations/org-1/groups",
    );
    expect(reread).toBeGreaterThan(post);
  });

  it("lists the groups of an organization as cards with Ver grupo and no workspace button", async () => {
    mockTransport(baseRoutes());
    renderApp({ route: DETAIL });
    expect(await screen.findByText("Contabilidad")).toBeTruthy();
    expect(screen.getByText("Equipo comercial")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Ver grupo Contabilidad" }),
    ).toHaveProperty("href", expect.stringContaining(`${DETAIL}/group-a`));
    expect(screen.getByRole("link", { name: "Ver grupo Ventas" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Trabajar con/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Crear grupo" })).toBeTruthy();
  });

  it("shows only own groups and no administration controls to a regular member", async () => {
    const member = profileFixture({
      memberships: [
        membership(north, "USER", {
          groups: [
            {
              group: { id: "group-b", name: "Ventas" },
              effective: { ...none, readInvoices: true },
            },
          ],
        }),
      ],
    });
    mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: member }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations/org-1/groups": () =>
        jsonResponse({ groups: [sales] }),
    });
    renderApp({ route: "/groups" });
    expect(await screen.findByText("Ventas")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Crear grupo/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Guardar permisos/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Trabajar con/ })).toBeNull();
    // The human summary of my effective flags (from the profile) replaces raw flags.
    expect(screen.getByText("Puede leer facturas")).toBeTruthy();
  });

  it("lists my groups per organization with a human summary of permissions and a link to each group", async () => {
    mockTransport(baseRoutes());
    renderApp({ route: "/groups" });
    expect(await screen.findByText("Contabilidad")).toBeTruthy();
    // Only groups I belong to show what I can do: Ventas reads, Operaciones
    // grants nothing, and Contabilidad (not mine) shows no summary at all.
    expect(await screen.findByText("Operaciones")).toBeTruthy();
    expect(screen.getAllByText("Sin permisos sobre facturas")).toHaveLength(1);
    expect(screen.getAllByText("Puede leer facturas")).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: /^Ver grupo / })).toHaveLength(
      3,
    );
    expect(screen.queryByRole("button", { name: /Trabajar con/ })).toBeNull();
    // ADMIN of both organizations: one create action per section.
    expect(
      screen.getByRole("link", { name: "Crear grupo en Academia Norte" }),
    ).toHaveProperty(
      "href",
      expect.stringContaining("/organizations/org-1/groups/new"),
    );
    expect(
      screen.getByRole("link", { name: "Crear grupo en Instituto Sur" }),
    ).toBeTruthy();
  });
});

describe("group summary and members table", () => {
  it("shows an ADMIN the group data, the member count and the way to the members", async () => {
    mockTransport({
      ...baseRoutes(),
      "GET /api/v1/organizations/org-1/groups/group-b/memberships": () =>
        jsonResponse({
          memberships: [carlaInGroup({ ...none }, "group-b")],
        }),
    });
    renderApp({ route: `${DETAIL}/group-b` });
    await screen.findByRole("heading", { level: 1, name: "Ventas" });
    expect(await screen.findByText("Equipo comercial")).toBeTruthy();
    const summary = screen.getByRole("region", { name: "Resumen" });
    expect(summary.textContent).toContain("Miembros1");
    expect(screen.getByRole("link", { name: "Miembros" })).toHaveProperty(
      "href",
      expect.stringContaining(`${DETAIL}/group-b/members`),
    );
    // Name and description are read-only text: there is no form to edit them.
    expect(screen.queryByLabelText("Nombre del grupo")).toBeNull();
    expect(
      screen.queryByRole("group", { name: "Permisos sobre facturas" }),
    ).toBeNull();
  });

  it("shows a regular member their effective permissions read-only and no member controls", async () => {
    const member = profileFixture({
      memberships: [
        membership(north, "USER", {
          groups: [
            {
              group: { id: "group-b", name: "Ventas" },
              effective: { ...none, readInvoices: true },
            },
          ],
        }),
      ],
    });
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: member }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations/org-1/groups": () =>
        jsonResponse({ groups: [sales] }),
    });
    renderApp({ route: `${DETAIL}/group-b` });
    await screen.findByRole("heading", { level: 1, name: "Ventas" });
    // Presentation only: a sentence from the profile, never editable flags.
    expect(screen.getByText("Puede leer facturas")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("group", { name: /Permisos/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Guardar/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Miembros" })).toBeNull();
    // A USER never reads the member lists: no extra requests.
    expect(
      transport.requests.filter(({ path }) =>
        /\/(memberships|users)$/.test(path),
      ),
    ).toEqual([]);
  });

  it("denies the members screen to a regular member without reading the list", async () => {
    const member = profileFixture({
      memberships: [membership(north, "USER")],
    });
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: member }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations/org-1/groups": () =>
        jsonResponse({ groups: [sales] }),
    });
    renderApp({ route: `${DETAIL}/group-b/members` });
    expect(
      await screen.findByText(
        "Solo los administradores de la organización pueden ver a los miembros de un grupo.",
      ),
    ).toBeTruthy();
    expect(
      transport.requests.filter(({ path }) => /\/memberships$/.test(path)),
    ).toEqual([]);
  });

  it("says a group the person cannot see was not found", async () => {
    mockTransport(baseRoutes());
    renderApp({ route: `${DETAIL}/group-zzz` });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Página no encontrada",
      }),
    ).toBeTruthy();
  });

  it("lists the members with their permission summary and selects them for a bulk edit", async () => {
    mockTransport({
      ...baseRoutes(),
      [MEMBERS_A]: () =>
        jsonResponse({
          memberships: [
            carlaInGroup({ ...none, readInvoices: true, createInvoices: true }),
            adaInGroup(),
          ],
        }),
    });
    renderApp({ route: `${DETAIL}/group-a/members` });
    const carlaRow = (await screen.findByText("Carla Soto")).closest(
      "tr",
    ) as HTMLElement;
    expect(within(carlaRow).getByText("19.034.790-7")).toBeTruthy();
    expect(within(carlaRow).getByText("2 de 4 permisos")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Carla Soto" })).toHaveProperty(
      "href",
      expect.stringContaining(`${DETAIL}/group-a/members/user-3`),
    );
    const bulk = screen.getByRole("button", {
      name: "Editar permisos en bloque",
    });
    expect(bulk).toHaveProperty("disabled", true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Seleccionar a Carla Soto" }),
    );
    expect(bulk).toHaveProperty("disabled", false);
    expect(screen.getByText("1 persona seleccionada.")).toBeTruthy();
    // "Seleccionar todos" selects everyone and clears again.
    const all = screen.getByRole("checkbox", { name: "Seleccionar todos" });
    fireEvent.click(all);
    expect(screen.getByText("2 personas seleccionadas.")).toBeTruthy();
    fireEvent.click(all);
    expect(bulk).toHaveProperty("disabled", true);
    fireEvent.click(all);
    fireEvent.click(bulk);
    await screen.findByRole("heading", {
      level: 1,
      name: "Editar permisos en bloque",
    });
    expect(window.location.pathname).toBe(
      `${DETAIL}/group-a/members/permissions`,
    );
    expect(window.location.search).toBe("?userIds=user-3,user-1");
  });
});

describe("group member permissions editor (v2)", () => {
  const EDITOR = "Permisos en el grupo «Contabilidad» — Carla Soto";

  it("offers four independent labelled toggles per member, off by default", async () => {
    mockTransport({
      ...baseRoutes(),
      [MEMBERS_A]: () => jsonResponse({ memberships: [carlaInGroup()] }),
    });
    renderApp({ route: `${DETAIL}/group-a/members/user-3` });
    const editor = await screen.findByRole("group", { name: EDITOR });
    const pressed = (label: string) =>
      within(editor)
        .getByRole("button", { name: label })
        .getAttribute("aria-pressed");
    for (const label of [
      "Leer facturas",
      "Crear facturas",
      "Eliminar facturas propias",
      "Eliminar facturas de otros",
    ])
      expect(pressed(label)).toBe("false");
    // Toggling one flag does not imply any other.
    fireEvent.click(
      within(editor).getByRole("button", {
        name: "Eliminar facturas de otros",
      }),
    );
    expect(pressed("Eliminar facturas de otros")).toBe("true");
    expect(pressed("Eliminar facturas propias")).toBe("false");
  });

  it("shows the saved flags of the member", async () => {
    mockTransport({
      ...baseRoutes(),
      "GET /api/v1/organizations/org-1/groups/group-b/memberships": () =>
        jsonResponse({
          memberships: [
            carlaInGroup({ ...none, readInvoices: true }, "group-b"),
          ],
        }),
    });
    renderApp({ route: `${DETAIL}/group-b/members/user-3` });
    const editor = await screen.findByRole("group", {
      name: "Permisos en el grupo «Ventas» — Carla Soto",
    });
    expect(
      within(editor)
        .getByRole("button", { name: "Leer facturas" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("PUTs all four flags and invalidates only the profile, this group's memberships and this organization's memberships", async () => {
    const transport = mockTransport({
      ...baseRoutes(),
      [MEMBERS_A]: () => jsonResponse({ memberships: [carlaInGroup()] }),
      [PUT_CARLA]: () => jsonResponse({ membership: carlaInGroup() }),
    });
    const { store } = renderApp({
      route: `${DETAIL}/group-a/members/user-3`,
    });
    const editor = await screen.findByRole("group", { name: EDITOR });
    const client = store.getSnapshot().client;
    // Seeded neighbours: the organization's people, another group, another org.
    client.setQueryData(
      ["identity", "user-1", "org", "org-1", "memberships"],
      [],
    );
    client.setQueryData(
      ["identity", "user-1", "org", "org-1", "group", "group-b", "memberships"],
      [],
    );
    client.setQueryData(
      ["identity", "user-1", "org", "org-2", "memberships"],
      [],
    );
    const before = {
      groupsNorth: transport.calls("GET /api/v1/organizations/org-1/groups")
        .length,
      membersA: transport.calls(MEMBERS_A).length,
      profile: transport.calls("GET /api/v1/auth/profile").length,
    };

    const save = screen.getByRole("button", {
      name: "Guardar permisos de Carla Soto",
    });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.click(
      within(editor).getByRole("button", { name: "Crear facturas" }),
    );
    fireEvent.click(
      within(editor).getByRole("button", { name: "Eliminar facturas propias" }),
    );
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    await screen.findByText("Permisos guardados");

    expect(transport.calls(PUT_CARLA)[0].body).toEqual({
      permissions: {
        readInvoices: false,
        createInvoices: true,
        deleteOwnInvoices: true,
        deleteOthersInvoices: false,
      },
    });
    await waitFor(() =>
      expect(transport.calls(MEMBERS_A)).toHaveLength(before.membersA + 1),
    );
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(
        before.profile + 1,
      ),
    );
    const stale = (key: string[]) => client.getQueryState(key)?.isInvalidated;
    expect(stale(["identity", "user-1", "org", "org-1", "memberships"])).toBe(
      true,
    );
    // Untouched: another group, another organization, the group catalogue.
    expect(
      stale([
        "identity",
        "user-1",
        "org",
        "org-1",
        "group",
        "group-b",
        "memberships",
      ]),
    ).toBe(false);
    expect(stale(["identity", "user-1", "org", "org-2", "memberships"])).toBe(
      false,
    );
    expect(
      transport.calls("GET /api/v1/organizations/org-1/groups"),
    ).toHaveLength(before.groupsNorth);
    expect(
      transport.calls("GET /api/v1/organizations/org-2/groups"),
    ).toHaveLength(0);
  });

  it("explains a rejected permission change without losing the draft", async () => {
    mockTransport({
      ...baseRoutes(),
      [MEMBERS_A]: () => jsonResponse({ memberships: [carlaInGroup()] }),
      [PUT_CARLA]: () => errorResponse(403, "FORBIDDEN"),
    });
    renderApp({ route: `${DETAIL}/group-a/members/user-3` });
    const editor = await screen.findByRole("group", { name: EDITOR });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Leer facturas" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Guardar permisos de Carla Soto" }),
    );
    expect(
      await screen.findByText("No tienes permiso para realizar esta acción."),
    ).toBeTruthy();
    expect(
      within(editor)
        .getByRole("button", { name: "Leer facturas" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("removes the member from the group after a confirmation and goes back to the members", async () => {
    let memberships = [carlaInGroup(), adaInGroup()];
    const transport = mockTransport({
      ...baseRoutes(),
      [MEMBERS_A]: () => jsonResponse({ memberships }),
      "DELETE /api/v1/organizations/org-1/groups/group-a/memberships/user-3":
        () => {
          memberships = memberships.filter(
            (entry) => entry.userId !== "user-3",
          );
          return new Response(null, { status: 204 });
        },
    });
    renderApp({ route: `${DETAIL}/group-a/members/user-3` });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar a Carla Soto del grupo",
      }),
    );
    // Nothing is sent until the removal is confirmed.
    expect(
      transport.calls(
        "DELETE /api/v1/organizations/org-1/groups/group-a/memberships/user-3",
      ),
    ).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Carla Soto" }),
    );
    expect(
      await screen.findByText("Se quitó a Carla Soto del grupo."),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(`${DETAIL}/group-a/members`);
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Carla Soto" })).toBeNull(),
    );
    expect(screen.getByRole("link", { name: "Ada Lovelace" })).toBeTruthy();
  });
});

describe("bulk group permissions", () => {
  const bulkRoute = `${DETAIL}/group-a/members/permissions?userIds=user-3,user-1`;

  it("sets the same four flags on the selected members and goes back with a status message", async () => {
    const transport = mockTransport({
      ...baseRoutes(),
      [MEMBERS_A]: () =>
        jsonResponse({ memberships: [carlaInGroup(), adaInGroup()] }),
      [BULK_PUT]: () =>
        jsonResponse({ memberships: [carlaInGroup(), adaInGroup()] }),
    });
    renderApp({ route: bulkRoute });
    await screen.findByText("Carla Soto");
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Marcar todos" }));
    fireEvent.click(screen.getByRole("button", { name: "Desmarcar todos" }));
    fireEvent.click(screen.getByRole("button", { name: "Leer facturas" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Aplicar a 2 miembros" }),
    );
    await screen.findByText("Permisos actualizados para 2 miembros.");
    expect(transport.calls(BULK_PUT)[0].body).toEqual({
      userIds: ["user-3", "user-1"],
      permissions: { ...none, readInvoices: true },
    });
    expect(window.location.pathname).toBe(`${DETAIL}/group-a/members`);
  });

  it("starts from the flags everybody shares and says when they differ", async () => {
    mockTransport({
      ...baseRoutes(),
      [MEMBERS_A]: () =>
        jsonResponse({
          memberships: [
            carlaInGroup({ ...none, createInvoices: true }),
            adaInGroup({ ...none, createInvoices: true }),
          ],
        }),
    });
    const { unmount } = renderApp({ route: bulkRoute });
    await screen.findByText("Carla Soto");
    expect(
      screen
        .getByRole("button", { name: "Crear facturas" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByText(/permisos distintos/)).toBeNull();
    unmount();
    cleanup();
    mockTransport({
      ...baseRoutes(),
      [MEMBERS_A]: () =>
        jsonResponse({
          memberships: [
            carlaInGroup({ ...none, createInvoices: true }),
            adaInGroup(),
          ],
        }),
    });
    renderApp({ route: bulkRoute });
    await screen.findByText("Carla Soto");
    expect(screen.getByText(/permisos distintos/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Crear facturas" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("keeps the person on the screen with the draft when the server rejects the batch", async () => {
    mockTransport({
      ...baseRoutes(),
      [MEMBERS_A]: () =>
        jsonResponse({ memberships: [carlaInGroup(), adaInGroup()] }),
      [BULK_PUT]: () => errorResponse(404, "NOT_FOUND"),
    });
    renderApp({ route: bulkRoute });
    await screen.findByText("Carla Soto");
    fireEvent.click(screen.getByRole("button", { name: "Leer facturas" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Aplicar a 2 miembros" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No se encontró el recurso solicitado.",
    );
    expect(window.location.pathname).toBe(
      `${DETAIL}/group-a/members/permissions`,
    );
    expect(
      screen
        .getByRole("button", { name: "Leer facturas" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("leaves out selected people who are no longer in the group and asks for a selection when there is none", async () => {
    mockTransport({
      ...baseRoutes(),
      [MEMBERS_A]: () => jsonResponse({ memberships: [carlaInGroup()] }),
    });
    renderApp({
      route: `${DETAIL}/group-a/members/permissions?userIds=user-3,gone`,
    });
    await screen.findByText("Carla Soto");
    expect(
      screen.getByText(
        "1 persona de la selección ya no está disponible y se omitió.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Aplicar a 1 miembro" }),
    ).toBeTruthy();
    cleanup();
    mockTransport({
      ...baseRoutes(),
      [MEMBERS_A]: () => jsonResponse({ memberships: [carlaInGroup()] }),
    });
    renderApp({ route: `${DETAIL}/group-a/members/permissions` });
    expect(
      (await screen.findByText("No hay personas seleccionadas.")).getAttribute(
        "role",
      ),
    ).toBe("alert");
  });
});

describe("adding members to a group", () => {
  const NEW_MEMBERS = `${DETAIL}/group-a/members/new`;
  const withExtra = [
    ...orgUsers,
    { id: "user-5", name: "Diego Peña", rut: "111111111", role: "USER" },
  ];
  const routes = () => ({
    ...baseRoutes(),
    "GET /api/v1/organizations/org-1/users": () =>
      jsonResponse({ users: withExtra }),
    [MEMBERS_A]: () => jsonResponse({ memberships: [carlaInGroup()] }),
  });

  it("offers only the organization members who are not in the group yet, filtered by name or RUT", async () => {
    mockTransport(routes());
    renderApp({ route: NEW_MEMBERS });
    expect(
      await screen.findByRole("checkbox", { name: /Ada Lovelace/ }),
    ).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Diego Peña/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Carla Soto/ })).toBeNull();
    const search = screen.getByLabelText("Buscar por nombre o RUT");
    // Accents and case are ignored.
    fireEvent.change(search, { target: { value: "pena" } });
    expect(screen.queryByRole("checkbox", { name: /Ada Lovelace/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Diego Peña/ })).toBeTruthy();
    // A RUT matches with any spelling of dots and dash.
    fireEvent.change(search, { target: { value: "12.345.678-5" } });
    expect(screen.getByRole("checkbox", { name: /Ada Lovelace/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Diego Peña/ })).toBeNull();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(
      screen.getByText("Ninguna persona coincide con la búsqueda."),
    ).toBeTruthy();
  });

  it("adds everybody in one atomic request, each with their own permissions", async () => {
    const transport = mockTransport({
      ...routes(),
      [BULK_POST]: () =>
        jsonResponse({ memberships: [adaInGroup(), adaInGroup()] }, 201),
    });
    renderApp({ route: NEW_MEMBERS });
    await screen.findByRole("checkbox", { name: /Ada Lovelace/ });
    const submit = screen.getByRole("button", {
      name: "Agregar personas al grupo",
    });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Seleccionar todos" }),
    );
    expect(screen.getByText("2 personas seleccionadas.")).toBeTruthy();
    // Each chosen person gets a card with a one-line summary and an editor.
    const adaCard = screen.getByRole("region", { name: "Ada Lovelace" });
    fireEvent.click(
      within(adaCard).getByRole("button", { name: "Ada Lovelace" }),
    );
    fireEvent.click(
      within(adaCard).getByRole("button", { name: "Leer facturas" }),
    );
    expect(within(adaCard).getByText("1 de 4 permisos")).toBeTruthy();
    // The same permissions can be copied to everybody selected.
    const shared = screen.getByRole("region", {
      name: "Aplicar los mismos permisos a todos",
    });
    fireEvent.click(
      within(shared).getByRole("button", { name: "Crear facturas" }),
    );
    fireEvent.click(
      within(shared).getByRole("button", {
        name: "Aplicar a todos los seleccionados",
      }),
    );
    const diegoCard = screen.getByRole("region", { name: "Diego Peña" });
    expect(within(diegoCard).getAllByText("1 de 4 permisos")).not.toHaveLength(
      0,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Agregar 2 personas al grupo" }),
    );
    await screen.findByText("2 personas agregadas al grupo.");
    expect(window.location.pathname).toBe(`${DETAIL}/group-a/members`);
    expect(transport.calls(BULK_POST)).toHaveLength(1);
    expect(transport.calls(BULK_POST)[0].body).toEqual({
      members: [
        { userId: "user-1", permissions: { ...none, createInvoices: true } },
        { userId: "user-5", permissions: { ...none, createInvoices: true } },
      ],
    });
    // Nothing else was written: no per-person request.
    expect(
      transport.requests.filter(
        ({ method, path }) => method !== "GET" && !path.endsWith("/bulk"),
      ),
    ).toEqual([]);
  });

  it("explains a rejected batch, says nobody was added and keeps the selection for a retry", async () => {
    let attempts = 0;
    const transport = mockTransport({
      ...routes(),
      [BULK_POST]: () => {
        attempts += 1;
        return attempts === 1
          ? errorResponse(409, "ORGANIZATION_MEMBERSHIP_REQUIRED")
          : jsonResponse({ memberships: [] }, 201);
      },
    });
    renderApp({ route: NEW_MEMBERS });
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Ada Lovelace/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Agregar 1 persona al grupo" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "La persona debe pertenecer a la organización antes de asignarla a un grupo.",
    );
    expect(alert.textContent).toContain("No se agregó a nadie.");
    expect(window.location.pathname).toBe(NEW_MEMBERS);
    // The same request is simply sent again.
    fireEvent.click(
      screen.getByRole("button", { name: "Agregar 1 persona al grupo" }),
    );
    await screen.findByText("1 persona agregada al grupo.");
    expect(transport.calls(BULK_POST)).toHaveLength(2);
  });

  it("tells when everybody in the organization is already in the group", async () => {
    mockTransport({
      ...baseRoutes(),
      [MEMBERS_A]: () =>
        jsonResponse({ memberships: [carlaInGroup(), adaInGroup()] }),
    });
    renderApp({ route: NEW_MEMBERS });
    expect(await screen.findByText(/todas ya están en el grupo/)).toBeTruthy();
  });
});
