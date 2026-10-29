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
  NO_PERMISSIONS,
  orgMembershipsPage,
  pageEnvelope,
  profileFixture,
  usersPage,
} from "./test/transport";
import { uuid } from "./test/ids";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const north = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia Norte",
};
const south = {
  id: "00000000-0000-4000-9000-000000000002",
  name: "Instituto Sur",
};
const members = [
  {
    userId: "00000000-0000-4000-8000-000000000001",
    organizationId: "00000000-0000-4000-9000-000000000001",
    role: "ADMIN",
    permissions: NO_PERMISSIONS,
    groups: [],
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Ada Lovelace",
      rut: "123456785",
    },
  },
  {
    userId: "00000000-0000-4000-8000-000000000003",
    organizationId: "00000000-0000-4000-9000-000000000001",
    role: "USER",
    permissions: { ...NO_PERMISSIONS, readInvoices: true },
    groups: [
      {
        groupId: "00000000-0000-4000-a000-000000000097",
        name: "Contabilidad",
        permissions: NO_PERMISSIONS,
      },
      {
        groupId: "00000000-0000-4000-a000-000000000098",
        name: "Ventas",
        permissions: { ...NO_PERMISSIONS, createInvoices: true },
      },
    ],
    user: {
      id: "00000000-0000-4000-8000-000000000003",
      name: "Carla Soto",
      rut: "190347907",
    },
  },
];

function routes(profile: unknown) {
  return {
    "GET /api/v1/auth/profile": () => jsonResponse({ profile }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001": () =>
      jsonResponse({
        organization: {
          id: "00000000-0000-4000-9000-000000000001",
          name: "Academia Norte",
          slug: "00000000-0000-4000-9000-000000000001",
          description: null,
        },
        summary: { memberCount: 2, groupCount: 2 },
      }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
      () => jsonResponse(orgMembershipsPage(members)),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups":
      () =>
        jsonResponse({
          groups: [
            {
              id: "00000000-0000-4000-a000-000000000097",
              organizationId: "00000000-0000-4000-9000-000000000001",
              name: "Contabilidad",
              description: null,
            },
            {
              id: "00000000-0000-4000-a000-000000000098",
              organizationId: "00000000-0000-4000-9000-000000000001",
              name: "Ventas",
              description: null,
            },
          ],
        }),
    ...[
      "00000000-0000-4000-a000-000000000097",
      "00000000-0000-4000-a000-000000000098",
    ].reduce(
      (all, groupId) => ({
        ...all,
        [`GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/${groupId}/memberships`]:
          () =>
            jsonResponse({
              memberships: [
                {
                  userId: "00000000-0000-4000-8000-000000000003",
                  groupId,
                  organizationId: "00000000-0000-4000-9000-000000000001",
                  permissions: NO_PERMISSIONS,
                  user: members[1].user,
                },
              ],
            }),
      }),
      {},
    ),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
      () =>
        jsonResponse(
          usersPage(members.map(({ user, role }) => ({ ...user, role }))),
        ),
    // The reduced list every member of the organization may read.
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/members":
      () =>
        jsonResponse(
          pageEnvelope("members", [
            {
              userId: "00000000-0000-4000-8000-000000000001",
              name: "Ada Lovelace",
              email: "ada@example.test",
              recentlyActive: true,
            },
            {
              userId: "00000000-0000-4000-8000-000000000003",
              name: "Carla Soto",
              email: null,
              recentlyActive: false,
            },
          ]),
        ),
  };
}

const PUT =
  "PUT /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/00000000-0000-4000-8000-000000000003/permissions";
const adminProfile = profileFixture({
  memberships: [membership(north, "ADMIN"), membership(south, "ADMIN")],
});

describe("organization members with permissions (v2)", () => {
  it("shows each member's role, group names and permission summary in the table to an ADMIN", async () => {
    mockTransport(routes(adminProfile));
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
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
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members/00000000-0000-4000-8000-000000000003",
    });
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

  // AC-22: the route is no longer manage-only. A plain member reads the
  // reduced list (/members) and never the management one (/memberships).
  it("shows a regular member the reduced list, without any administrative control", async () => {
    const transport = mockTransport(
      routes(profileFixture({ memberships: [membership(north, "USER")] })),
    );
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    const table = await screen.findByRole("table", {
      name: "Miembros de la organización",
    });
    expect(
      within(table)
        .getByRole("link", { name: "Ada Lovelace" })
        .getAttribute("href"),
    ).toBe("/users/00000000-0000-4000-8000-000000000001");
    expect(within(table).getByText("ada@example.test")).toBeTruthy();
    expect(within(table).getByText("Sin correo")).toBeTruthy();
    expect(within(table).getByText("Activo")).toBeTruthy();
    expect(within(table).getByText("Inactivo")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Editar permisos en bloque" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Agregar miembro" })).toBeNull();
    expect(screen.queryByText("Ver en Admin")).toBeNull();
    expect(
      transport.calls(
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships",
      ),
    ).toHaveLength(0);
    expect(
      transport.calls(
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/members",
      )[0].search,
    ).toBe("?page=1&pageSize=20");
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
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    expect(await screen.findByText("Carla Soto")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Agregar miembro" }));
    await screen.findByRole("heading", { level: 1, name: "Agregar miembro" });
    fireEvent.click(screen.getByRole("tab", { name: "Crear persona nueva" }));
    expect(
      screen
        .getByRole("link", { name: /Usa el asistente de administración/ })
        .getAttribute("href"),
    ).toBe(
      "/admin/users/new?organizationId=00000000-0000-4000-9000-000000000001",
    );
  });

  it("PUTs the four flags and refreshes only the profile and this organization's memberships", async () => {
    const transport = mockTransport({
      ...routes(adminProfile),
      [PUT]: () => jsonResponse({ membership: members[1] }),
    });
    const { store } = renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members/00000000-0000-4000-8000-000000000003",
    });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    await screen.findByRole("button", { name: /Contabilidad/ });
    const client = store.getSnapshot().client;
    const key = (...parts: string[]) => [
      "identity",
      "00000000-0000-4000-8000-000000000001",
      ...parts,
    ];
    // Seeded neighbours that must stay fresh.
    client.setQueryData(
      key("org", "00000000-0000-4000-9000-000000000002", "memberships"),
      [],
    );
    client.setQueryData(
      key(
        "org",
        "00000000-0000-4000-9000-000000000001",
        "group",
        "00000000-0000-4000-a000-000000000122",
        "memberships",
      ),
      [],
    );
    const before = {
      memberships: transport.calls(
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships",
      ).length,
      users: transport.calls(
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/users",
      ).length,
      profile: transport.calls("GET /api/v1/auth/profile").length,
      groups: transport.calls(
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups",
      ).length,
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
        transport.calls(
          "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships",
        ),
      ).toHaveLength(before.memberships + 1),
    );
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(
        before.profile + 1,
      ),
    );
    // Nothing else is refetched or marked stale.
    expect(
      transport.calls(
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/users",
      ),
    ).toHaveLength(before.users);
    expect(
      transport.calls(
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups",
      ),
    ).toHaveLength(before.groups);
    expect(
      client.getQueryState(
        key("org", "00000000-0000-4000-9000-000000000002", "memberships"),
      )?.isInvalidated,
    ).toBe(false);
    expect(
      client.getQueryState(
        key(
          "org",
          "00000000-0000-4000-9000-000000000001",
          "group",
          "00000000-0000-4000-a000-000000000122",
          "memberships",
        ),
      )?.isInvalidated,
    ).toBe(false);
    expect(
      transport.calls(
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000002/memberships",
      ),
    ).toHaveLength(0);
  });

  it("adds an existing person with a draft of organization permissions (default all off)", async () => {
    const transport = mockTransport({
      ...routes(adminProfile),
      "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
        () =>
          jsonResponse(
            {
              membership: {
                userId: "00000000-0000-4000-8000-000000000004",
                organizationId: "00000000-0000-4000-9000-000000000001",
                role: "USER",
                permissions: NO_PERMISSIONS,
              },
            },
            201,
          ),
    });
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members/new",
    });
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
      transport.calls(
        "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships",
      )[0].body,
    ).toEqual({
      rut: "19034790-7",
      role: "USER",
      permissions: { ...NO_PERMISSIONS, createInvoices: true },
    });
    expect(window.location.pathname).toBe(
      "/organizations/00000000-0000-4000-9000-000000000001/members",
    );
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
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members/00000000-0000-4000-8000-000000000003",
    });
    expect(
      await screen.findByRole("group", {
        name: "Permisos en el grupo «Contabilidad» — Carla Soto",
      }),
    ).toBeTruthy();
  });
});

describe("bulk organization permissions", () => {
  const BULK_PUT =
    "PUT /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/permissions";

  it("selects members in the table and opens the bulk screen with the selection in the URL", async () => {
    mockTransport(routes(adminProfile));
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    await screen.findByText("Carla Soto");
    const bulk = screen.getByRole("button", {
      name: "Editar permisos en bloque",
    });
    expect(bulk).toHaveProperty("disabled", true);
    const all = screen.getByRole("checkbox", {
      name: "Seleccionar todos en esta página",
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Seleccionar a Carla Soto" }),
    );
    expect((all as HTMLInputElement).indeterminate).toBe(true);
    expect(bulk).toHaveProperty("disabled", false);
    fireEvent.click(all);
    expect(
      screen.getByText("2 personas seleccionadas en esta página."),
    ).toBeTruthy();
    fireEvent.click(bulk);
    await screen.findByRole("heading", {
      level: 1,
      name: "Editar permisos en bloque",
    });
    expect(window.location.pathname).toBe(
      "/organizations/00000000-0000-4000-9000-000000000001/members/permissions",
    );
    expect(window.location.search).toBe(
      "?userIds=00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000003",
    );
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
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members/permissions?userIds=00000000-0000-4000-8000-000000000003,00000000-0000-4000-8000-000000000001",
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
      userIds: [
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000001",
      ],
      permissions: {
        readInvoices: true,
        createInvoices: true,
        deleteOwnInvoices: true,
        deleteOthersInvoices: false,
      },
    });
    expect(window.location.pathname).toBe(
      "/organizations/00000000-0000-4000-9000-000000000001/members",
    );
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
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members/permissions?userIds=00000000-0000-4000-8000-000000000003,00000000-0000-4000-8000-000000000001",
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
      "/organizations/00000000-0000-4000-9000-000000000001/members/permissions",
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
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members/permissions?userIds=00000000-0000-4000-8000-000000000003",
    });
    expect(
      await screen.findByText(
        "Solo los administradores de la organización pueden editar permisos.",
      ),
    ).toBeTruthy();
    expect(
      transport.calls(
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships",
      ),
    ).toHaveLength(0);
  });
});

describe("paginated management table (AC-18, AC-23)", () => {
  const person = (n: number, extra: Record<string, unknown> = {}) => ({
    userId: uuid(n),
    organizationId: "00000000-0000-4000-9000-000000000001",
    role: "USER",
    permissions: NO_PERMISSIONS,
    groups: [],
    user: {
      id: uuid(n),
      name: `Persona ${n}`,
      rut: "190347907",
      disabled: false,
      recentlyActive: true,
      ...extra,
    },
  });

  /** A server of 45 members that honours page and pageSize. */
  function pagedRoutes(profile: unknown, total = 45) {
    return {
      ...routes(profile),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
        ({ search }: { search: string }) => {
          const query = new URLSearchParams(search);
          const page = Number(query.get("page"));
          const pageSize = Number(query.get("pageSize"));
          const all = Array.from({ length: total }, (_unused, index) =>
            person(
              index + 1,
              index === 1 ? { disabled: true, recentlyActive: false } : {},
            ),
          );
          return jsonResponse({
            memberships: all.slice((page - 1) * pageSize, page * pageSize),
            page,
            pageSize,
            total,
          });
        },
    };
  }

  it("asks for 20 per page, shows Estado and Actividad as text and pages through the URL", async () => {
    const transport = mockTransport(pagedRoutes(adminProfile));
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    const region = await screen.findByRole("region", {
      name: "Miembros de la organización",
    });
    const table = within(region).getByRole("table");
    expect(
      transport.calls(
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships",
      )[0].search,
    ).toBe("?page=1&pageSize=20");
    const headers = within(table)
      .getAllByRole("columnheader")
      .map((c) => c.textContent);
    expect(headers).toContain("Estado");
    expect(headers).toContain("Actividad");
    expect(within(table).getAllByRole("row")).toHaveLength(21);
    const second = within(
      screen
        .getByRole("link", { name: "Persona 2" })
        .closest("tr") as HTMLElement,
    );
    expect(second.getByText("Desactivado")).toBeTruthy();
    expect(second.getByText("Inactivo")).toBeTruthy();
    const first = within(
      screen
        .getByRole("link", { name: "Persona 1" })
        .closest("tr") as HTMLElement,
    );
    expect(first.getByText("Habilitado")).toBeTruthy();
    expect(first.getByText("Activo")).toBeTruthy();

    expect(screen.getByText("Página 1 de 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByRole("link", { name: "Persona 21" });
    expect(window.location.search).toBe("?page=2");
    expect(screen.queryByRole("link", { name: "Persona 1" })).toBeNull();
    expect(screen.getByText("Página 2 de 3")).toBeTruthy();
    expect(
      transport
        .calls(
          "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships",
        )
        .at(-1)?.search,
    ).toBe("?page=2&pageSize=20");
  });

  it("opens straight on a page from the URL", async () => {
    mockTransport(pagedRoutes(adminProfile));
    renderApp({
      route:
        "/organizations/00000000-0000-4000-9000-000000000001/members?page=3",
    });
    await screen.findByRole("link", { name: "Persona 41" });
    expect(screen.getByText("Página 3 de 3")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Siguiente" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("selects and edits in bulk only the people of the current page", async () => {
    mockTransport(pagedRoutes(adminProfile));
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    await screen.findByRole("link", { name: "Persona 1" });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Seleccionar a Persona 1" }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Seleccionar a Persona 2" }),
    );
    expect(
      screen.getByText("2 personas seleccionadas en esta página."),
    ).toBeTruthy();

    // "Seleccionar todos" selects the 20 rows of the page, not the 45.
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Seleccionar todos en esta página",
      }),
    );
    expect(
      screen.getByText("20 personas seleccionadas en esta página."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByRole("link", { name: "Persona 21" });
    expect(screen.getByText(/Selecciona personas para editar/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Editar permisos en bloque" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Seleccionar a Persona 21" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Editar permisos en bloque" }),
    );
    await screen.findByRole("heading", {
      level: 1,
      name: "Editar permisos en bloque",
    });
    expect(window.location.search).toBe(
      "?userIds=00000000-0000-4000-8000-000000000021",
    );
  });

  it("clears the selection when the page changes, so coming back starts over (CR-293)", async () => {
    mockTransport(pagedRoutes(adminProfile));
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    await screen.findByRole("link", { name: "Persona 1" });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Seleccionar a Persona 1" }),
    );
    expect(
      screen.getByText("1 persona seleccionada en esta página."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByRole("link", { name: "Persona 21" });
    fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    await screen.findByRole("link", { name: "Persona 1" });
    // Nothing is ticked any more, and the bulk action cannot carry old people.
    expect(
      screen.getByRole("checkbox", { name: "Seleccionar a Persona 1" }),
    ).toHaveProperty("checked", false);
    expect(screen.getByText(/Selecciona personas para editar/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Editar permisos en bloque" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("links each row to the Admin profile for the platform administrator only", async () => {
    mockTransport(
      pagedRoutes(
        profileFixture({
          isPlatformAdministrator: true,
          memberships: [membership(north, "USER")],
        }),
      ),
    );
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    const link = await screen.findByRole("link", {
      name: "Ver en Admin: Persona 3",
    });
    expect(link.getAttribute("href")).toBe(
      "/admin/users/00000000-0000-4000-8000-000000000003",
    );
    cleanup();
    vi.restoreAllMocks();

    mockTransport(pagedRoutes(adminProfile));
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    await screen.findByRole("link", { name: "Persona 3" });
    expect(screen.queryByText("Ver en Admin")).toBeNull();
  });

  it("paginates the reduced list of a plain member too", async () => {
    const transport = mockTransport({
      ...routes(profileFixture({ memberships: [membership(north, "USER")] })),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/members":
        ({ search }) => {
          const query = new URLSearchParams(search);
          const page = Number(query.get("page"));
          return jsonResponse({
            members: [
              {
                userId: uuid(page),
                name: `Persona ${page}`,
                email: null,
                recentlyActive: true,
              },
            ],
            page,
            pageSize: 20,
            total: 30,
          });
        },
    });
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    await screen.findByRole("link", { name: "Persona 1" });
    expect(screen.getByText("Página 1 de 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByRole("link", { name: "Persona 2" });
    expect(window.location.search).toBe("?page=2");
    expect(
      transport
        .calls(
          "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/members",
        )
        .at(-1)?.search,
    ).toBe("?page=2&pageSize=20");
  });

  it("opens the member list of an organization the platform administrator does not belong to", async () => {
    const transport = mockTransport({
      ...pagedRoutes(platformProfile()),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001": () =>
        jsonResponse({
          organization: {
            id: "00000000-0000-4000-9000-000000000001",
            name: "Academia Norte",
            slug: "norte",
            description: null,
          },
          summary: { memberCount: 45, groupCount: 0 },
        }),
    });
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    expect(await screen.findByRole("link", { name: "Persona 1" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Agregar miembro" })).toBeTruthy();
    expect(
      transport.calls(
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001",
      ),
    ).toHaveLength(1);
  });
});

function platformProfile() {
  return profileFixture({ isPlatformAdministrator: true, memberships: [] });
}
