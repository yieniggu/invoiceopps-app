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
  NO_PERMISSIONS,
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

const north = { id: "org-1", name: "Academia Norte" };
const south = { id: "org-2", name: "Instituto Sur" };
const members = [
  {
    userId: "user-1",
    organizationId: "org-1",
    role: "ADMIN",
    permissions: NO_PERMISSIONS,
    groups: [],
    user: { id: "user-1", name: "Ada Lovelace", rut: "123456785" },
  },
  {
    userId: "user-3",
    organizationId: "org-1",
    role: "USER",
    permissions: { ...NO_PERMISSIONS, readInvoices: true },
    groups: [
      { groupId: "group-a", name: "Contabilidad", permissions: NO_PERMISSIONS },
      {
        groupId: "group-b",
        name: "Ventas",
        permissions: { ...NO_PERMISSIONS, createInvoices: true },
      },
    ],
    user: { id: "user-3", name: "Carla Soto", rut: "190347907" },
  },
];

function routes(profile: unknown) {
  return {
    "GET /api/v1/auth/profile": () => jsonResponse({ profile }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations/org-1": () =>
      jsonResponse({
        organization: {
          id: "org-1",
          name: "Academia Norte",
          slug: "org-1",
          description: null,
        },
        summary: { memberCount: 2, groupCount: 2 },
      }),
    "GET /api/v1/organizations/org-1/memberships": () =>
      jsonResponse({ memberships: members }),
    "GET /api/v1/organizations/org-1/groups": () =>
      jsonResponse({
        groups: [
          {
            id: "group-a",
            organizationId: "org-1",
            name: "Contabilidad",
            description: null,
          },
          {
            id: "group-b",
            organizationId: "org-1",
            name: "Ventas",
            description: null,
          },
        ],
      }),
    ...["group-a", "group-b"].reduce(
      (all, groupId) => ({
        ...all,
        [`GET /api/v1/organizations/org-1/groups/${groupId}/memberships`]: () =>
          jsonResponse({
            memberships: [
              {
                userId: "user-3",
                groupId,
                organizationId: "org-1",
                permissions: NO_PERMISSIONS,
                user: members[1].user,
              },
            ],
          }),
      }),
      {},
    ),
    "GET /api/v1/organizations/org-1/users": () =>
      jsonResponse({
        users: members.map(({ user, role }) => ({ ...user, role })),
      }),
  };
}

const PUT = "PUT /api/v1/organizations/org-1/memberships/user-3/permissions";
const adminProfile = profileFixture({
  memberships: [membership(north, "ADMIN"), membership(south, "ADMIN")],
});

describe("organization members with permissions (v2)", () => {
  it("shows each member's role, group names and permission summary in the table to an ADMIN", async () => {
    mockTransport(routes(adminProfile));
    renderApp({ route: "/organizations/org-1/members" });
    const row = (await screen.findByText("Carla Soto")).closest(
      "tr",
    ) as HTMLElement;
    expect(within(row).getByText("Contabilidad, Ventas")).toBeTruthy();
    expect(within(row).getByText("Usuario")).toBeTruthy();
    expect(within(row).getByText("1 de 4 permisos")).toBeTruthy();
    const adminRow = screen
      .getByText("Ada Lovelace")
      .closest("tr") as HTMLElement;
    expect(within(adminRow).getByText("Sin grupos")).toBeTruthy();
    expect(within(adminRow).getByText("Administrador")).toBeTruthy();
  });

  it("shows the role and an organization-level editor on the member page", async () => {
    mockTransport(routes(adminProfile));
    renderApp({ route: "/organizations/org-1/members/user-3" });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    expect(
      (screen.getByLabelText("Rol de Carla Soto") as HTMLSelectElement).value,
    ).toBe("USER");
    const editor = screen.getByRole("group", {
      name: "Permisos en la organización «Academia Norte» — Carla Soto",
    });
    expect(
      within(editor)
        .getByRole("button", { name: "Leer facturas" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(editor)
        .getByRole("button", { name: "Crear facturas" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    // The groups of the person in this organization, each with its own card.
    expect(
      await screen.findByRole("button", { name: /Contabilidad/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ventas/ })).toBeTruthy();
  });

  it("is hidden from a regular member, who never reads the member list", async () => {
    const transport = mockTransport(
      routes(profileFixture({ memberships: [membership(north, "USER")] })),
    );
    renderApp({ route: "/organizations/org-1/members" });
    expect(
      await screen.findByText(
        "Solo los administradores de la organización pueden ver a sus miembros.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: /Permisos/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Guardar permisos/ }),
    ).toBeNull();
    expect(
      transport.calls("GET /api/v1/organizations/org-1/memberships"),
    ).toHaveLength(0);
  });

  it("is available to the platform administrator, who also gets the platform wizard link", async () => {
    mockTransport(
      routes(
        profileFixture({
          isPlatformAdministrator: true,
          memberships: [membership(north, "USER")],
        }),
      ),
    );
    renderApp({ route: "/organizations/org-1/members" });
    expect(await screen.findByText("Carla Soto")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Agregar miembro" }));
    await screen.findByRole("heading", { level: 1, name: "Agregar miembro" });
    fireEvent.click(screen.getByRole("tab", { name: "Crear persona nueva" }));
    expect(
      screen
        .getByRole("link", { name: /Usa el asistente de administración/ })
        .getAttribute("href"),
    ).toBe("/admin/users/new?organizationId=org-1");
  });

  it("PUTs the four flags and refreshes only the profile and this organization's memberships", async () => {
    const transport = mockTransport({
      ...routes(adminProfile),
      [PUT]: () => jsonResponse({ membership: members[1] }),
    });
    const { store } = renderApp({
      route: "/organizations/org-1/members/user-3",
    });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    await screen.findByRole("button", { name: /Contabilidad/ });
    const client = store.getSnapshot().client;
    const key = (...parts: string[]) => ["identity", "user-1", ...parts];
    // Seeded neighbours that must stay fresh.
    client.setQueryData(key("org", "org-2", "memberships"), []);
    client.setQueryData(
      key("org", "org-1", "group", "group-z", "memberships"),
      [],
    );
    const before = {
      memberships: transport.calls(
        "GET /api/v1/organizations/org-1/memberships",
      ).length,
      users: transport.calls("GET /api/v1/organizations/org-1/users").length,
      profile: transport.calls("GET /api/v1/auth/profile").length,
      groups: transport.calls("GET /api/v1/organizations/org-1/groups").length,
    };

    const editor = screen.getByRole("group", {
      name: "Permisos en la organización «Academia Norte» — Carla Soto",
    });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Eliminar facturas propias" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Guardar permisos de Carla Soto" }),
    );
    await screen.findByText("Permisos guardados");

    expect(transport.calls(PUT)[0].body).toEqual({
      permissions: {
        readInvoices: true,
        createInvoices: false,
        deleteOwnInvoices: true,
        deleteOthersInvoices: false,
      },
    });
    await waitFor(() =>
      expect(
        transport.calls("GET /api/v1/organizations/org-1/memberships"),
      ).toHaveLength(before.memberships + 1),
    );
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(
        before.profile + 1,
      ),
    );
    // Nothing else is refetched or marked stale.
    expect(
      transport.calls("GET /api/v1/organizations/org-1/users"),
    ).toHaveLength(before.users);
    expect(
      transport.calls("GET /api/v1/organizations/org-1/groups"),
    ).toHaveLength(before.groups);
    expect(
      client.getQueryState(key("org", "org-2", "memberships"))?.isInvalidated,
    ).toBe(false);
    expect(
      client.getQueryState(
        key("org", "org-1", "group", "group-z", "memberships"),
      )?.isInvalidated,
    ).toBe(false);
    expect(
      transport.calls("GET /api/v1/organizations/org-2/memberships"),
    ).toHaveLength(0);
  });

  it("adds an existing person with a draft of organization permissions (default all off)", async () => {
    const transport = mockTransport({
      ...routes(adminProfile),
      "POST /api/v1/organizations/org-1/memberships": () =>
        jsonResponse(
          {
            membership: {
              userId: "user-4",
              organizationId: "org-1",
              role: "USER",
              permissions: NO_PERMISSIONS,
            },
          },
          201,
        ),
    });
    renderApp({ route: "/organizations/org-1/members/new" });
    await screen.findByRole("heading", { level: 1, name: "Agregar miembro" });
    const draft = screen.getByRole("group", {
      name: "Permisos en la organización — la persona a asignar",
    });
    expect(
      within(draft)
        .getAllByRole("button", { pressed: false })
        .filter((button) => !/todos/.test(button.textContent ?? "")),
    ).toHaveLength(4);
    fireEvent.change(screen.getByLabelText(/RUT de la persona/), {
      target: { value: "190347907" },
    });
    fireEvent.click(
      within(draft).getByRole("button", { name: "Crear facturas" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Agregar persona" }));
    await screen.findByText("Persona agregada a la organización.");
    expect(
      transport.calls("POST /api/v1/organizations/org-1/memberships")[0].body,
    ).toEqual({
      rut: "19034790-7",
      role: "USER",
      permissions: { ...NO_PERMISSIONS, createInvoices: true },
    });
    expect(window.location.pathname).toBe("/organizations/org-1/members");
  });
});

describe("group members for the platform administrator", () => {
  it("shows group-level editors to a platform administrator who is only a USER member", async () => {
    mockTransport({
      ...routes(
        profileFixture({
          isPlatformAdministrator: true,
          memberships: [membership(north, "USER")],
        }),
      ),
    });
    renderApp({ route: "/organizations/org-1/groups/group-a/members/user-3" });
    expect(
      await screen.findByRole("group", {
        name: "Permisos en el grupo «Contabilidad» — Carla Soto",
      }),
    ).toBeTruthy();
  });
});

describe("bulk organization permissions", () => {
  const BULK_PUT = "PUT /api/v1/organizations/org-1/memberships/permissions";

  it("selects members in the table and opens the bulk screen with the selection in the URL", async () => {
    mockTransport(routes(adminProfile));
    renderApp({ route: "/organizations/org-1/members" });
    await screen.findByText("Carla Soto");
    const bulk = screen.getByRole("button", {
      name: "Editar permisos en bloque",
    });
    expect(bulk).toHaveProperty("disabled", true);
    const all = screen.getByRole("checkbox", { name: "Seleccionar todos" });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Seleccionar a Carla Soto" }),
    );
    expect((all as HTMLInputElement).indeterminate).toBe(true);
    expect(bulk).toHaveProperty("disabled", false);
    fireEvent.click(all);
    expect(screen.getByText("2 personas seleccionadas.")).toBeTruthy();
    fireEvent.click(bulk);
    await screen.findByRole("heading", {
      level: 1,
      name: "Editar permisos en bloque",
    });
    expect(window.location.pathname).toBe(
      "/organizations/org-1/members/permissions",
    );
    expect(window.location.search).toBe("?userIds=user-1,user-3");
    // A reload keeps the selection because it is the URL.
    expect(await screen.findByText("Carla Soto")).toBeTruthy();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });

  it("applies one set of flags to the selected members in a single request and goes back with a status message", async () => {
    const transport = mockTransport({
      ...routes(adminProfile),
      [BULK_PUT]: () => jsonResponse({ memberships: [] }),
    });
    renderApp({
      route: "/organizations/org-1/members/permissions?userIds=user-3,user-1",
    });
    await screen.findByText("Carla Soto");
    // The members differ (Carla reads, Ada has nothing): the editor starts blank.
    expect(screen.getByText(/permisos distintos/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Marcar todos" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Eliminar facturas de otros" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Aplicar a 2 miembros" }),
    );
    await screen.findByText("Permisos actualizados para 2 miembros.");
    expect(transport.calls(BULK_PUT)).toHaveLength(1);
    expect(transport.calls(BULK_PUT)[0].body).toEqual({
      userIds: ["user-3", "user-1"],
      permissions: {
        readInvoices: true,
        createInvoices: true,
        deleteOwnInvoices: true,
        deleteOthersInvoices: false,
      },
    });
    expect(window.location.pathname).toBe("/organizations/org-1/members");
    // The profile is refreshed too: the actor may be one of the members.
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/auth/profile").length).toBe(2),
    );
  });

  it("keeps the draft on the screen when the server rejects the whole batch", async () => {
    mockTransport({
      ...routes(adminProfile),
      [BULK_PUT]: () => errorResponse(404, "NOT_FOUND"),
    });
    renderApp({
      route: "/organizations/org-1/members/permissions?userIds=user-3,user-1",
    });
    await screen.findByText("Carla Soto");
    fireEvent.click(screen.getByRole("button", { name: "Marcar todos" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Aplicar a 2 miembros" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No se encontró el recurso solicitado.",
    );
    expect(window.location.pathname).toBe(
      "/organizations/org-1/members/permissions",
    );
    expect(
      screen
        .getByRole("button", { name: "Leer facturas" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("denies the bulk screen to a regular member", async () => {
    const transport = mockTransport(
      routes(profileFixture({ memberships: [membership(north, "USER")] })),
    );
    renderApp({
      route: "/organizations/org-1/members/permissions?userIds=user-3",
    });
    expect(
      await screen.findByText(
        "Solo los administradores de la organización pueden editar permisos.",
      ),
    ).toBeTruthy();
    expect(
      transport.calls("GET /api/v1/organizations/org-1/memberships"),
    ).toHaveLength(0);
  });
});
