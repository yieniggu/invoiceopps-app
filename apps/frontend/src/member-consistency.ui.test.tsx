import {
  act,
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
  deferred,
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

// B3b-FIX: the member screens read the server's truth before they move on,
// recover from a conflict, avoid one request per group and keep announcements
// and focus where assistive technology can find them.

const north = { id: "org-1", name: "Academia Norte" };
const adminProfile = profileFixture({
  memberships: [membership(north, "ADMIN")],
});
const READ = { ...NO_PERMISSIONS, readInvoices: true };

const ada = {
  userId: "user-1",
  organizationId: "org-1",
  role: "ADMIN",
  permissions: NO_PERMISSIONS,
  groups: [] as unknown[],
  user: { id: "user-1", name: "Ada Lovelace", rut: "123456785" },
};
const carlaGroups = [
  {
    groupId: "group-a",
    name: "Contabilidad",
    permissions: { ...NO_PERMISSIONS, createInvoices: true },
  },
  { groupId: "group-b", name: "Ventas", permissions: READ },
];
const carla = {
  userId: "user-3",
  organizationId: "org-1",
  role: "USER",
  permissions: READ,
  groups: carlaGroups as unknown[],
  user: { id: "user-3", name: "Carla Soto", rut: "190347907" },
};
const diego = {
  userId: "user-5",
  organizationId: "org-1",
  role: "USER",
  permissions: NO_PERMISSIONS,
  groups: [] as unknown[],
  user: { id: "user-5", name: "Diego Peña", rut: "111111111" },
};

const groupA = {
  id: "group-a",
  organizationId: "org-1",
  name: "Contabilidad",
  description: null,
};
const groupB = {
  id: "group-b",
  organizationId: "org-1",
  name: "Ventas",
  description: null,
};

const MEMBERSHIPS = "GET /api/v1/organizations/org-1/memberships";
const USERS = "GET /api/v1/organizations/org-1/users";
const GROUP_A_MEMBERS =
  "GET /api/v1/organizations/org-1/groups/group-a/memberships";

const asUser = (member: {
  user: { id: string; name: string; rut: string };
  role: string;
}) => ({
  ...member.user,
  role: member.role,
});
const inGroup = (
  member: { userId: string; user: { id: string; name: string; rut: string } },
  groupId = "group-a",
  permissions = NO_PERMISSIONS,
) => ({
  userId: member.userId,
  groupId,
  organizationId: "org-1",
  permissions,
  user: member.user,
});

function baseRoutes(people: Array<typeof ada> = [ada, carla]) {
  return {
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: adminProfile }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations/org-1": () =>
      jsonResponse({
        organization: { ...north, slug: "org-1", description: null },
        summary: { memberCount: people.length, groupCount: 2 },
      }),
    [MEMBERSHIPS]: () => jsonResponse({ memberships: people }),
    [USERS]: () => jsonResponse({ users: people.map(asUser) }),
    "GET /api/v1/organizations/org-1/groups": () =>
      jsonResponse({ groups: [groupA, groupB] }),
  };
}

const perGroupMembershipReads = (
  requests: Array<{ method: string; path: string }>,
) =>
  requests.filter(
    ({ method, path }) =>
      method === "GET" &&
      /^\/api\/v1\/organizations\/[^/]+\/groups\/[^/]+\/memberships$/.test(
        path,
      ),
  );

describe("CR-217 the member page needs no request per group", () => {
  it("shows each group's flags from the memberships payload without reading any group list", async () => {
    const transport = mockTransport(baseRoutes());
    renderApp({ route: "/organizations/org-1/members/user-3" });

    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    const accounting = screen.getByRole("region", { name: "Contabilidad" });
    const sales = screen.getByRole("region", { name: "Ventas" });
    // Folded cards already summarize the flags: no "Cargando permisos...".
    expect(within(accounting).getByText("1 de 4 permisos")).toBeTruthy();
    expect(within(sales).getByText("1 de 4 permisos")).toBeTruthy();
    expect(screen.queryByText(/Cargando permisos/)).toBeNull();

    fireEvent.click(
      within(accounting).getByRole("button", { name: "Contabilidad" }),
    );
    const editor = within(accounting).getByRole("group", {
      name: "Permisos en el grupo «Contabilidad» — Carla Soto",
    });
    expect(
      within(editor)
        .getByRole("button", { name: "Crear facturas" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(editor)
        .getByRole("button", { name: "Leer facturas" })
        .getAttribute("aria-pressed"),
    ).toBe("false");

    expect(perGroupMembershipReads(transport.requests)).toEqual([]);
    expect(transport.unexpected).toEqual([]);
  });

  it("saves a group flag and refreshes the card from the organization's memberships", async () => {
    let people = [ada, carla];
    const transport = mockTransport({
      ...baseRoutes(),
      [MEMBERSHIPS]: () => jsonResponse({ memberships: people }),
      "PUT /api/v1/organizations/org-1/groups/group-a/memberships/user-3/permissions":
        () => {
          people = [
            ada,
            {
              ...carla,
              groups: [
                {
                  ...carlaGroups[0],
                  permissions: {
                    ...NO_PERMISSIONS,
                    createInvoices: true,
                    readInvoices: true,
                  },
                },
                carlaGroups[1],
              ],
            },
          ];
          return jsonResponse({ membership: {} });
        },
    });
    renderApp({ route: "/organizations/org-1/members/user-3" });
    const accounting = await screen.findByRole("region", {
      name: "Contabilidad",
    });
    fireEvent.click(
      within(accounting).getByRole("button", { name: "Contabilidad" }),
    );
    fireEvent.click(
      within(accounting).getByRole("button", { name: "Leer facturas" }),
    );
    fireEvent.click(
      within(accounting).getByRole("button", {
        name: "Guardar permisos de Carla Soto",
      }),
    );

    await within(accounting).findByText("Permisos guardados");
    await waitFor(() => expect(transport.calls(MEMBERSHIPS)).toHaveLength(2));
    expect(perGroupMembershipReads(transport.requests)).toEqual([]);
    fireEvent.click(
      within(accounting).getByRole("button", { name: "Contabilidad" }),
    );
    expect(within(accounting).getByText("2 de 4 permisos")).toBeTruthy();
  });
});

describe("CR-216 flows navigate only after the lists are fresh", () => {
  it("removing an organization member waits for the refetch before going to the list", async () => {
    let people = [ada, carla];
    let hold: ReturnType<typeof deferred<Response>> | undefined;
    const DELETE = "DELETE /api/v1/organizations/org-1/memberships/user-3";
    const transport = mockTransport({
      ...baseRoutes(),
      [MEMBERSHIPS]: () =>
        hold ? hold.promise : jsonResponse({ memberships: people }),
      [DELETE]: () => {
        people = [ada];
        hold = deferred<Response>();
        return new Response(null, { status: 204 });
      },
    });
    renderApp({ route: "/organizations/org-1/members/user-3" });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar a Carla Soto de la organización",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Carla Soto" }),
    );

    await waitFor(() => expect(transport.calls(DELETE)).toHaveLength(1));
    await waitFor(() => expect(transport.calls(MEMBERSHIPS)).toHaveLength(2));
    // The refetch is still in flight: the person has not been moved.
    expect(window.location.pathname).toBe(
      "/organizations/org-1/members/user-3",
    );

    hold?.resolve(jsonResponse({ memberships: people }));
    await screen.findByText("Se quitó a Carla Soto de la organización.");
    expect(window.location.pathname).toBe("/organizations/org-1/members");
    // The list they land on is already the fresh one.
    expect(screen.queryByRole("link", { name: "Carla Soto" })).toBeNull();
    expect(screen.getByRole("link", { name: "Ada Lovelace" })).toBeTruthy();
  });

  it("removing a group member waits for the group's refetch before going to its list", async () => {
    let inA = [inGroup(carla), inGroup(ada)];
    let hold: ReturnType<typeof deferred<Response>> | undefined;
    const DELETE =
      "DELETE /api/v1/organizations/org-1/groups/group-a/memberships/user-3";
    const transport = mockTransport({
      ...baseRoutes(),
      [GROUP_A_MEMBERS]: () =>
        hold ? hold.promise : jsonResponse({ memberships: inA }),
      [DELETE]: () => {
        inA = [inGroup(ada)];
        hold = deferred<Response>();
        return new Response(null, { status: 204 });
      },
    });
    renderApp({ route: "/organizations/org-1/groups/group-a/members/user-3" });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar a Carla Soto del grupo",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Carla Soto" }),
    );

    await waitFor(() => expect(transport.calls(DELETE)).toHaveLength(1));
    await waitFor(() =>
      expect(transport.calls(GROUP_A_MEMBERS)).toHaveLength(2),
    );
    expect(window.location.pathname).toBe(
      "/organizations/org-1/groups/group-a/members/user-3",
    );

    hold?.resolve(jsonResponse({ memberships: inA }));
    await screen.findByText("Se quitó a Carla Soto del grupo.");
    expect(window.location.pathname).toBe(
      "/organizations/org-1/groups/group-a/members",
    );
    expect(screen.queryByRole("link", { name: "Carla Soto" })).toBeNull();
  });

  it("adding people to a group waits for the refetch of its members before going to the list", async () => {
    let inA = [inGroup(carla)];
    let hold: ReturnType<typeof deferred<Response>> | undefined;
    const POST =
      "POST /api/v1/organizations/org-1/groups/group-a/memberships/bulk";
    const transport = mockTransport({
      ...baseRoutes([ada, carla, diego]),
      [GROUP_A_MEMBERS]: () =>
        hold ? hold.promise : jsonResponse({ memberships: inA }),
      [POST]: () => {
        inA = [inGroup(carla), inGroup(diego)];
        hold = deferred<Response>();
        return jsonResponse({ memberships: [] }, 201);
      },
    });
    renderApp({ route: "/organizations/org-1/groups/group-a/members/new" });
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Diego Peña/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Agregar 1 persona al grupo" }),
    );

    await waitFor(() => expect(transport.calls(POST)).toHaveLength(1));
    await waitFor(() =>
      expect(transport.calls(GROUP_A_MEMBERS)).toHaveLength(2),
    );
    expect(window.location.pathname).toBe(
      "/organizations/org-1/groups/group-a/members/new",
    );

    hold?.resolve(jsonResponse({ memberships: inA }));
    await screen.findByText("1 persona agregada al grupo.");
    expect(window.location.pathname).toBe(
      "/organizations/org-1/groups/group-a/members",
    );
    expect(screen.getByRole("link", { name: "Diego Peña" })).toBeTruthy();
  });

  it("adding an existing person to the organization lands on a list that already has them", async () => {
    let people = [ada];
    const POST = "POST /api/v1/organizations/org-1/memberships";
    const transport = mockTransport({
      ...baseRoutes([ada]),
      [MEMBERSHIPS]: () => jsonResponse({ memberships: people }),
      [POST]: () => {
        people = [ada, diego];
        return jsonResponse(
          {
            membership: {
              userId: "user-5",
              organizationId: "org-1",
              role: "USER",
              permissions: NO_PERMISSIONS,
            },
          },
          201,
        );
      },
    });
    renderApp({ route: "/organizations/org-1/members/new" });
    fireEvent.change(await screen.findByLabelText(/RUT de la persona/), {
      target: { value: "111111111" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Agregar persona" }));

    await screen.findByText("Persona agregada a la organización.");
    expect(window.location.pathname).toBe("/organizations/org-1/members");
    // The first read of the list happens after the write: nothing stale.
    expect(
      await screen.findByRole("link", { name: "Diego Peña" }),
    ).toBeTruthy();
    expect(transport.calls(MEMBERSHIPS)).toHaveLength(1);
  });
});

describe("CR-215 a conflict refreshes the people and names who is gone", () => {
  it("bulk add: after a 409 the form drops and names the person who joined meanwhile", async () => {
    let inA = [inGroup(carla)];
    let first = true;
    const POST =
      "POST /api/v1/organizations/org-1/groups/group-a/memberships/bulk";
    const transport = mockTransport({
      ...baseRoutes([ada, carla, diego]),
      [GROUP_A_MEMBERS]: () => jsonResponse({ memberships: inA }),
      [POST]: () => {
        if (first) {
          first = false;
          // Diego was added by someone else in the meantime.
          inA = [inGroup(carla), inGroup(diego)];
          return errorResponse(409, "MEMBERSHIP_CONFLICT");
        }
        return jsonResponse({ memberships: [] }, 201);
      },
    });
    renderApp({ route: "/organizations/org-1/groups/group-a/members/new" });
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Diego Peña/ }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Ada Lovelace/ }));
    expect(screen.getByText("2 personas seleccionadas.")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Agregar 2 personas al grupo" }),
    );

    // The lists are re-read and the person who is no longer a candidate is named.
    await screen.findByText(/Diego Peña ya no se puede agregar al grupo/);
    expect(transport.calls(GROUP_A_MEMBERS).length).toBeGreaterThanOrEqual(2);
    expect(transport.calls(USERS).length).toBeGreaterThanOrEqual(2);
    // The selection was pruned to who can still be added.
    expect(screen.queryByRole("checkbox", { name: /Diego Peña/ })).toBeNull();
    expect(screen.getByText("1 persona seleccionada.")).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: /Ada Lovelace/ }),
    ).toHaveProperty("checked", true);
    expect(
      screen
        .getAllByRole("alert")
        .map((alert) => alert.textContent)
        .join(" "),
    ).toContain("No se agregó a nadie.");

    // Retrying sends only the person who is still selected.
    fireEvent.click(
      screen.getByRole("button", { name: "Agregar 1 persona al grupo" }),
    );
    await screen.findByText("1 persona agregada al grupo.");
    expect(transport.calls(POST)[1]?.body).toEqual({
      members: [{ userId: "user-1", permissions: NO_PERMISSIONS }],
    });
  });

  it("bulk add: a person who stopped being a candidate and comes back is not selected again", async () => {
    let inA = [inGroup(carla)];
    let first = true;
    const POST =
      "POST /api/v1/organizations/org-1/groups/group-a/memberships/bulk";
    mockTransport({
      ...baseRoutes([ada, carla, diego]),
      [GROUP_A_MEMBERS]: () => jsonResponse({ memberships: inA }),
      [POST]: () => {
        if (first) {
          first = false;
          inA = [inGroup(carla), inGroup(diego)];
          return errorResponse(409, "MEMBERSHIP_CONFLICT");
        }
        return jsonResponse({ memberships: [] }, 201);
      },
    });
    const { store } = renderApp({
      route: "/organizations/org-1/groups/group-a/members/new",
    });
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Diego Peña/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Agregar 1 persona al grupo" }),
    );
    await screen.findByText(/Diego Peña ya no se puede agregar al grupo/);
    expect(screen.queryByRole("checkbox", { name: /Diego Peña/ })).toBeNull();

    // Diego leaves the group again: he is a candidate again, unselected.
    inA = [inGroup(carla)];
    await act(async () => {
      await store.getSnapshot().client.invalidateQueries({
        queryKey: ["identity", "user-1", "org", "org-1", "group", "group-a"],
      });
    });
    const back = await screen.findByRole("checkbox", { name: /Diego Peña/ });
    expect(back).toHaveProperty("checked", false);
    expect(screen.getByText("Aún no seleccionas a nadie.")).toBeTruthy();
  });

  it("bulk add: a 404 because someone left the organization also refreshes and names them", async () => {
    let people = [ada, carla, diego];
    let first = true;
    const POST =
      "POST /api/v1/organizations/org-1/groups/group-a/memberships/bulk";
    const transport = mockTransport({
      ...baseRoutes(),
      [MEMBERSHIPS]: () => jsonResponse({ memberships: people }),
      [USERS]: () => jsonResponse({ users: people.map(asUser) }),
      [GROUP_A_MEMBERS]: () => jsonResponse({ memberships: [inGroup(carla)] }),
      [POST]: () => {
        if (!first) return jsonResponse({ memberships: [] }, 201);
        first = false;
        people = [ada, carla];
        return errorResponse(404, "NOT_FOUND");
      },
    });
    renderApp({ route: "/organizations/org-1/groups/group-a/members/new" });
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Diego Peña/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Agregar 1 persona al grupo" }),
    );

    await screen.findByText(/Diego Peña ya no se puede agregar al grupo/);
    await waitFor(() =>
      expect(transport.calls(USERS).length).toBeGreaterThanOrEqual(2),
    );
    expect(screen.queryByRole("checkbox", { name: /Diego Peña/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Agregar personas al grupo" }),
    ).toHaveProperty("disabled", true);
  });

  it("bulk permissions: after a 404 the lists refresh and the person who left is named", async () => {
    let inA = [inGroup(carla), inGroup(diego)];
    let first = true;
    const PUT =
      "PUT /api/v1/organizations/org-1/groups/group-a/memberships/permissions";
    const transport = mockTransport({
      ...baseRoutes([ada, carla, diego]),
      [GROUP_A_MEMBERS]: () => jsonResponse({ memberships: inA }),
      [PUT]: () => {
        if (!first) return jsonResponse({ memberships: [] });
        first = false;
        inA = [inGroup(carla)];
        return errorResponse(404, "NOT_FOUND");
      },
    });
    renderApp({
      route:
        "/organizations/org-1/groups/group-a/members/permissions?userIds=user-3,user-5",
    });
    await screen.findByText("Diego Peña");
    fireEvent.click(screen.getByRole("button", { name: "Leer facturas" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Aplicar a 2 miembros" }),
    );

    await screen.findByText(/Diego Peña ya no está disponible/);
    expect(transport.calls(GROUP_A_MEMBERS).length).toBeGreaterThanOrEqual(2);
    // The selection is pruned to who remains, ready for a retry.
    expect(
      screen.getByRole("button", { name: "Aplicar a 1 miembro" }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(
      "/organizations/org-1/groups/group-a/members/permissions",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Aplicar a 1 miembro" }),
    );
    await screen.findByText("Permisos actualizados para 1 miembro.");
    expect(transport.calls(PUT)[1]?.body).toEqual({
      userIds: ["user-3"],
      permissions: { ...NO_PERMISSIONS, readInvoices: true },
    });
  });

  it("organization bulk permissions: names everybody who left and says none is left", async () => {
    let people = [ada, carla, diego];
    const PUT = "PUT /api/v1/organizations/org-1/memberships/permissions";
    mockTransport({
      ...baseRoutes(),
      [MEMBERSHIPS]: () => jsonResponse({ memberships: people }),
      [PUT]: () => {
        people = [ada];
        return errorResponse(404, "NOT_FOUND");
      },
    });
    renderApp({
      route: "/organizations/org-1/members/permissions?userIds=user-3,user-5",
    });
    await screen.findByText("Diego Peña");
    fireEvent.click(screen.getByRole("button", { name: "Leer facturas" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Aplicar a 2 miembros" }),
    );

    await screen.findByText(/Carla Soto, Diego Peña ya no están disponibles/);
    expect(
      screen.getByText(
        "Ninguna de las personas seleccionadas pertenece a la organización.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Aplicar a/ })).toBeNull();
  });

  it("does not refresh anything for an unrelated failure", async () => {
    const PUT = "PUT /api/v1/organizations/org-1/memberships/permissions";
    const transport = mockTransport({
      ...baseRoutes([ada, carla]),
      [PUT]: () => errorResponse(403, "FORBIDDEN"),
    });
    renderApp({
      route: "/organizations/org-1/members/permissions?userIds=user-3",
    });
    await screen.findByText("Carla Soto");
    fireEvent.click(screen.getByRole("button", { name: "Crear facturas" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Aplicar a 1 miembro" }),
    );
    await screen.findByText("No tienes permiso para realizar esta acción.");
    expect(transport.calls(MEMBERSHIPS)).toHaveLength(1);
  });
});

describe("CR-235 announcements and focus around destructive actions", () => {
  async function openCarlaGroup() {
    renderApp({ route: "/organizations/org-1/members/user-3" });
    const card = await screen.findByRole("region", { name: "Contabilidad" });
    fireEvent.click(within(card).getByRole("button", { name: "Contabilidad" }));
    return card;
  }

  it("announces leaving a group in a live region that outlives the card", async () => {
    let people = [ada, carla];
    mockTransport({
      ...baseRoutes(),
      [MEMBERSHIPS]: () => jsonResponse({ memberships: people }),
      "DELETE /api/v1/organizations/org-1/groups/group-a/memberships/user-3":
        () => {
          people = [ada, { ...carla, groups: [carlaGroups[1]] }];
          return new Response(null, { status: 204 });
        },
    });
    const card = await openCarlaGroup();
    fireEvent.click(
      within(card).getByRole("button", {
        name: "Quitar del grupo Contabilidad",
      }),
    );
    fireEvent.click(
      within(card).getByRole("button", {
        name: "Confirmar quitar del grupo Contabilidad",
      }),
    );

    const announcement = await screen.findByText(
      "Se quitó a Carla Soto del grupo Contabilidad.",
    );
    // The card is gone but its announcement is still on screen, in a status.
    expect(screen.queryByRole("region", { name: "Contabilidad" })).toBeNull();
    expect(announcement.getAttribute("role")).toBe("status");
    expect(announcement.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("region", { name: "Ventas" })).toBeTruthy();
  });

  it("returns focus to the trigger after cancelling and after confirming", async () => {
    mockTransport({
      ...baseRoutes(),
      "DELETE /api/v1/organizations/org-1/groups/group-a/memberships/user-3":
        () => errorResponse(500, "INTERNAL_ERROR"),
    });
    const card = await openCarlaGroup();
    fireEvent.click(
      within(card).getByRole("button", {
        name: "Quitar del grupo Contabilidad",
      }),
    );
    fireEvent.click(within(card).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(card).getByRole("button", {
          name: "Quitar del grupo Contabilidad",
        }),
      ),
    );
  });

  it("moves focus to the error alert when the removal fails", async () => {
    mockTransport({
      ...baseRoutes(),
      "DELETE /api/v1/organizations/org-1/groups/group-a/memberships/user-3":
        () => errorResponse(500, "INTERNAL_ERROR"),
    });
    const card = await openCarlaGroup();
    fireEvent.click(
      within(card).getByRole("button", {
        name: "Quitar del grupo Contabilidad",
      }),
    );
    fireEvent.click(
      within(card).getByRole("button", {
        name: "Confirmar quitar del grupo Contabilidad",
      }),
    );

    const alert = await within(card).findByText(
      "No fue posible quitar a la persona del grupo. Intenta nuevamente.",
    );
    expect(alert.getAttribute("role")).toBe("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });
});

describe("CR-236 changing your own role or leaving", () => {
  const selfRoutes = (extra: Record<string, () => Response> = {}) => ({
    ...baseRoutes([ada, carla]),
    ...extra,
  });

  it("asks before changing your own role and sends nothing when you cancel", async () => {
    const PATCH = "PATCH /api/v1/organizations/org-1/memberships/user-1";
    const transport = mockTransport(
      selfRoutes({ [PATCH]: () => jsonResponse({ membership: {} }) }),
    );
    renderApp({ route: "/organizations/org-1/members/user-1" });
    const select = (await screen.findByLabelText(
      "Rol de Ada Lovelace",
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "USER" } });

    const prompt = await screen.findByText(
      /Vas a cambiar tu propio rol a Usuario/,
    );
    expect(prompt.textContent).toContain("Dejarás de administrar");
    expect(transport.calls(PATCH)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByText(/Vas a cambiar tu propio rol/)).toBeNull();
    expect(transport.calls(PATCH)).toHaveLength(0);
    expect(select.value).toBe("ADMIN");
  });

  it("sends the change once confirmed", async () => {
    const PATCH = "PATCH /api/v1/organizations/org-1/memberships/user-1";
    const transport = mockTransport(
      selfRoutes({ [PATCH]: () => jsonResponse({ membership: {} }) }),
    );
    renderApp({ route: "/organizations/org-1/members/user-1" });
    fireEvent.change(await screen.findByLabelText("Rol de Ada Lovelace"), {
      target: { value: "USER" },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirmar cambio de rol" }),
    );
    await waitFor(() => expect(transport.calls(PATCH)).toHaveLength(1));
    expect(transport.calls(PATCH)[0]?.body).toEqual({ role: "USER" });
  });

  it("does not ask to change somebody else's role", async () => {
    const PATCH = "PATCH /api/v1/organizations/org-1/memberships/user-3";
    const transport = mockTransport(
      selfRoutes({ [PATCH]: () => jsonResponse({ membership: {} }) }),
    );
    renderApp({ route: "/organizations/org-1/members/user-3" });
    fireEvent.change(await screen.findByLabelText("Rol de Carla Soto"), {
      target: { value: "ADMIN" },
    });
    await waitFor(() => expect(transport.calls(PATCH)).toHaveLength(1));
    expect(screen.queryByText(/Vas a cambiar tu propio rol/)).toBeNull();
  });

  it("after removing yourself goes to your organizations with a notice, not to the member list", async () => {
    let profile = adminProfile;
    const DELETE = "DELETE /api/v1/organizations/org-1/memberships/user-1";
    const transport = mockTransport({
      ...selfRoutes(),
      "GET /api/v1/auth/profile": () => jsonResponse({ profile }),
      [DELETE]: () => {
        profile = profileFixture({ memberships: [] });
        return new Response(null, { status: 204 });
      },
    });
    renderApp({ route: "/organizations/org-1/members/user-1" });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar a Ada Lovelace de la organización",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Ada Lovelace" }),
    );

    await screen.findByText("Saliste de la organización «Academia Norte».");
    expect(window.location.pathname).toBe("/organizations");
    expect(transport.calls(DELETE)).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 1, name: "Organizaciones" }),
    ).toBeTruthy();
  });
});

/** Records whether the not-found page was ever on screen, however briefly. */
function watchNotFound() {
  let seen = false;
  const check = () => {
    if (document.body.textContent?.includes("Página no encontrada"))
      seen = true;
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return {
    seen: () => {
      check();
      return seen;
    },
    stop: () => observer.disconnect(),
  };
}

describe("CR-254 removing a person never shows not-found or forbidden on the way out", () => {
  it("organization member: the screen holds while the refresh drops the person", async () => {
    let people = [ada, carla];
    let hold: ReturnType<typeof deferred<Response>> | undefined;
    const DELETE = "DELETE /api/v1/organizations/org-1/memberships/user-3";
    const transport = mockTransport({
      ...baseRoutes(),
      [MEMBERSHIPS]: () =>
        hold ? hold.promise : jsonResponse({ memberships: people }),
      [DELETE]: () => {
        people = [ada];
        hold = deferred<Response>();
        return new Response(null, { status: 204 });
      },
    });
    renderApp({ route: "/organizations/org-1/members/user-3" });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar a Carla Soto de la organización",
      }),
    );
    const watcher = watchNotFound();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Carla Soto" }),
    );
    await waitFor(() => expect(transport.calls(MEMBERSHIPS)).toHaveLength(2));
    hold?.resolve(jsonResponse({ memberships: people }));
    await screen.findByText("Se quitó a Carla Soto de la organización.");
    expect(watcher.seen()).toBe(false);
    watcher.stop();
  });

  it("organization member: removing yourself never shows not-found or forbidden before Organizaciones", async () => {
    let profile = adminProfile;
    let people = [ada, carla];
    let hold: ReturnType<typeof deferred<Response>> | undefined;
    const DELETE = "DELETE /api/v1/organizations/org-1/memberships/user-1";
    const transport = mockTransport({
      ...baseRoutes(),
      "GET /api/v1/auth/profile": () => jsonResponse({ profile }),
      [MEMBERSHIPS]: () =>
        hold ? hold.promise : jsonResponse({ memberships: people }),
      [DELETE]: () => {
        profile = profileFixture({ memberships: [] });
        people = [carla];
        hold = deferred<Response>();
        return new Response(null, { status: 204 });
      },
    });
    renderApp({ route: "/organizations/org-1/members/user-1" });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar a Ada Lovelace de la organización",
      }),
    );
    const watcher = watchNotFound();
    const profileReads = transport.calls("GET /api/v1/auth/profile").length;
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Ada Lovelace" }),
    );
    await waitFor(() => expect(transport.calls(MEMBERSHIPS)).toHaveLength(2));
    // The profile that lost the organization is not read while the screen
    // still depends on it.
    expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(
      profileReads,
    );
    hold?.resolve(jsonResponse({ memberships: people }));
    await screen.findByText("Saliste de la organización «Academia Norte».");
    expect(window.location.pathname).toBe("/organizations");
    // The profile is refreshed after leaving.
    await waitFor(() =>
      expect(
        transport.calls("GET /api/v1/auth/profile").length,
      ).toBeGreaterThan(profileReads),
    );
    expect(watcher.seen()).toBe(false);
    watcher.stop();
  });

  it("group member: the screen holds while the refresh drops the person", async () => {
    let inA = [inGroup(carla), inGroup(ada)];
    let hold: ReturnType<typeof deferred<Response>> | undefined;
    const DELETE =
      "DELETE /api/v1/organizations/org-1/groups/group-a/memberships/user-3";
    const transport = mockTransport({
      ...baseRoutes(),
      [GROUP_A_MEMBERS]: () =>
        hold ? hold.promise : jsonResponse({ memberships: inA }),
      [DELETE]: () => {
        inA = [inGroup(ada)];
        hold = deferred<Response>();
        return new Response(null, { status: 204 });
      },
    });
    renderApp({ route: "/organizations/org-1/groups/group-a/members/user-3" });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar a Carla Soto del grupo",
      }),
    );
    const watcher = watchNotFound();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Carla Soto" }),
    );
    await waitFor(() =>
      expect(transport.calls(GROUP_A_MEMBERS)).toHaveLength(2),
    );
    hold?.resolve(jsonResponse({ memberships: inA }));
    await screen.findByText("Se quitó a Carla Soto del grupo.");
    expect(watcher.seen()).toBe(false);
    watcher.stop();
  });

  it("a failed removal gives the screen back (no stale frozen person)", async () => {
    const DELETE = "DELETE /api/v1/organizations/org-1/memberships/user-3";
    mockTransport({
      ...baseRoutes(),
      [DELETE]: () => errorResponse(500, "INTERNAL_ERROR"),
    });
    renderApp({ route: "/organizations/org-1/members/user-3" });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar a Carla Soto de la organización",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Carla Soto" }),
    );
    await screen.findByText(
      "No fue posible quitar al miembro. Intenta nuevamente.",
    );
    expect(window.location.pathname).toBe(
      "/organizations/org-1/members/user-3",
    );
  });
});

describe("CR-215 single-person writes refresh after a 404 or 409", () => {
  const key = (...parts: string[]) => [
    "identity",
    "user-1",
    "org",
    "org-1",
    ...parts,
  ];
  const USERS_KEY = key("users");
  const GROUP_A_KEY = key("group", "group-a", "memberships");

  /** Seeds the lists a conflict must refresh and reports which went stale. */
  function seed(client: {
    setQueryData: (key: string[], data: unknown) => unknown;
    getQueryState: (key: string[]) => { isInvalidated: boolean } | undefined;
  }) {
    client.setQueryData(USERS_KEY, []);
    client.setQueryData(GROUP_A_KEY, []);
    return {
      users: () => client.getQueryState(USERS_KEY)?.isInvalidated,
      group: () => client.getQueryState(GROUP_A_KEY)?.isInvalidated,
    };
  }

  it("adding to a group: a 409 refreshes the people and that group; a 500 refreshes nothing", async () => {
    const POST = "POST /api/v1/organizations/org-1/groups/group-a/memberships";
    for (const [status, refreshed] of [
      [409, true],
      [500, false],
    ] as const) {
      const transport = mockTransport({
        ...baseRoutes([ada, diego]),
        [POST]: () => errorResponse(status, "ERROR"),
      });
      const { store } = renderApp({
        route: "/organizations/org-1/members/user-5",
      });
      const addButton = await screen.findByRole("button", {
        name: "Agregar al grupo",
      });
      const stale = seed(store.getSnapshot().client);
      fireEvent.click(addButton);
      await waitFor(() => expect(transport.calls(POST)).toHaveLength(1));
      if (refreshed) {
        await waitFor(() =>
          expect(transport.calls(MEMBERSHIPS)).toHaveLength(2),
        );
        expect(stale.users()).toBe(true);
        expect(stale.group()).toBe(true);
      } else {
        await screen.findByText(/No fue posible agregar a la persona al grupo/);
        expect(transport.calls(MEMBERSHIPS)).toHaveLength(1);
        expect(stale.users()).toBe(false);
        expect(stale.group()).toBe(false);
      }
      cleanup();
    }
  });

  it("removing from a group: a 404 refreshes the people and that group", async () => {
    const DELETE =
      "DELETE /api/v1/organizations/org-1/groups/group-a/memberships/user-3";
    let people = [ada, carla];
    const transport = mockTransport({
      ...baseRoutes(),
      [MEMBERSHIPS]: () => jsonResponse({ memberships: people }),
      [DELETE]: () => {
        // Somebody else already removed Carla from the group.
        people = [ada, { ...carla, groups: [carlaGroups[1]] }];
        return errorResponse(404, "NOT_FOUND");
      },
    });
    const { store } = renderApp({
      route: "/organizations/org-1/members/user-3",
    });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    const stale = seed(store.getSnapshot().client);
    const card = await screen.findByRole("region", { name: "Contabilidad" });
    fireEvent.click(within(card).getByRole("button", { name: "Contabilidad" }));
    fireEvent.click(
      within(card).getByRole("button", {
        name: "Quitar del grupo Contabilidad",
      }),
    );
    fireEvent.click(
      within(card).getByRole("button", {
        name: "Confirmar quitar del grupo Contabilidad",
      }),
    );
    await waitFor(() => expect(transport.calls(DELETE)).toHaveLength(1));
    await waitFor(() => expect(transport.calls(MEMBERSHIPS)).toHaveLength(2));
    expect(stale.users()).toBe(true);
    expect(stale.group()).toBe(true);
    // The refreshed list no longer has the group: the card is gone.
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Contabilidad" })).toBeNull(),
    );
  });

  it("changing a role: a 409 refreshes the people", async () => {
    const PATCH = "PATCH /api/v1/organizations/org-1/memberships/user-3";
    const transport = mockTransport({
      ...baseRoutes(),
      [PATCH]: () => errorResponse(409, "LAST_ADMIN"),
    });
    const { store } = renderApp({
      route: "/organizations/org-1/members/user-3",
    });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    const stale = seed(store.getSnapshot().client);
    fireEvent.change(await screen.findByLabelText("Rol de Carla Soto"), {
      target: { value: "ADMIN" },
    });
    await waitFor(() => expect(transport.calls(PATCH)).toHaveLength(1));
    await waitFor(() => expect(transport.calls(MEMBERSHIPS)).toHaveLength(2));
    expect(stale.users()).toBe(true);
  });

  it("removing a member: a 404 refreshes the people", async () => {
    const DELETE = "DELETE /api/v1/organizations/org-1/memberships/user-3";
    let people = [ada, carla];
    const transport = mockTransport({
      ...baseRoutes(),
      [MEMBERSHIPS]: () => jsonResponse({ memberships: people }),
      [DELETE]: () => {
        people = [ada];
        return errorResponse(404, "NOT_FOUND");
      },
    });
    const { store } = renderApp({
      route: "/organizations/org-1/members/user-3",
    });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    const stale = seed(store.getSnapshot().client);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar a Carla Soto de la organización",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Carla Soto" }),
    );
    await waitFor(() => expect(transport.calls(MEMBERSHIPS)).toHaveLength(2));
    expect(stale.users()).toBe(true);
    // The person is gone for real: the screen says so instead of freezing.
    await screen.findByText(/No encontramos a esa persona/);
  });

  it("assigning a member: a 409 refreshes the people", async () => {
    const POST = "POST /api/v1/organizations/org-1/memberships";
    const transport = mockTransport({
      ...baseRoutes([ada]),
      [POST]: () => errorResponse(409, "ALREADY_MEMBER"),
    });
    const { store } = renderApp({ route: "/organizations/org-1/members/new" });
    await screen.findByLabelText(/RUT de la persona/);
    const stale = seed(store.getSnapshot().client);
    fireEvent.change(screen.getByLabelText(/RUT de la persona/), {
      target: { value: "111111111" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Agregar persona" }));
    await waitFor(() => expect(transport.calls(POST)).toHaveLength(1));
    await waitFor(() => expect(stale.users()).toBe(true));
  });
});

describe("CR-255 self role change keeps focus where the person is", () => {
  const PATCH = "PATCH /api/v1/organizations/org-1/memberships/user-1";
  const routes = () => ({
    ...baseRoutes([ada, carla]),
    [PATCH]: () => jsonResponse({ membership: {} }),
  });

  it("focuses the confirm button when the question appears and the role select on cancel", async () => {
    mockTransport(routes());
    renderApp({ route: "/organizations/org-1/members/user-1" });
    const select = (await screen.findByLabelText(
      "Rol de Ada Lovelace",
    )) as HTMLSelectElement;
    select.focus();
    fireEvent.change(select, { target: { value: "USER" } });
    const confirm = await screen.findByRole("button", {
      name: "Confirmar cambio de rol",
    });
    await waitFor(() => expect(document.activeElement).toBe(confirm));

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(document.activeElement).toBe(select));
  });

  it("returns focus to the role select after confirming", async () => {
    const transport = mockTransport(routes());
    renderApp({ route: "/organizations/org-1/members/user-1" });
    const select = await screen.findByLabelText("Rol de Ada Lovelace");
    fireEvent.change(select, { target: { value: "ADMIN" } });
    // Same value as the saved one still asks; any change does.
    fireEvent.change(select, { target: { value: "USER" } });
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirmar cambio de rol" }),
    );
    await waitFor(() => expect(transport.calls(PATCH)).toHaveLength(1));
    await waitFor(() => expect(document.activeElement).toBe(select));
  });
});

describe("CR-263 a one-shot notice does not outlive its render", () => {
  /** What a reload or Back would hand to the screen again. */
  const storedNotice = () =>
    (window.history.state as { usr?: { notice?: string } | null } | null)?.usr
      ?.notice;

  it("removing an organization member: the member list shows the notice once and clears it from history", async () => {
    let people = [ada, carla];
    mockTransport({
      ...baseRoutes(),
      [MEMBERSHIPS]: () => jsonResponse({ memberships: people }),
      "DELETE /api/v1/organizations/org-1/memberships/user-3": () => {
        people = [ada];
        return new Response(null, { status: 204 });
      },
    });
    renderApp({ route: "/organizations/org-1/members/user-3" });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar a Carla Soto de la organización",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Carla Soto" }),
    );

    const notice = await screen.findByText(
      "Se quitó a Carla Soto de la organización.",
    );
    expect(notice.getAttribute("role")).toBe("status");
    expect(window.location.pathname).toBe("/organizations/org-1/members");
    const entries = window.history.length;
    await waitFor(() => expect(storedNotice()).toBeUndefined());
    // Still visible for the current render, and the entry was replaced, not added.
    expect(
      screen.getByText("Se quitó a Carla Soto de la organización."),
    ).toBeTruthy();
    expect(window.history.length).toBe(entries);
  });

  it("creating a group: the add-members screen shows the notice and clears it", async () => {
    const POST = "POST /api/v1/organizations/org-1/groups";
    const created = { ...groupA, id: "group-9", name: "Nuevo" };
    let groups = [groupA, groupB];
    mockTransport({
      ...baseRoutes([ada, carla]),
      "GET /api/v1/organizations/org-1/groups": () => jsonResponse({ groups }),
      "GET /api/v1/organizations/org-1/groups/group-9/memberships": () =>
        jsonResponse({ memberships: [] }),
      [POST]: () => {
        groups = [...groups, created];
        return jsonResponse({ group: created }, 201);
      },
    });
    renderApp({ route: "/organizations/org-1/groups/new" });
    fireEvent.change(await screen.findByLabelText("Nombre del grupo"), {
      target: { value: "Nuevo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear grupo" }));

    await screen.findByText("Grupo creado. Agrega a sus miembros.");
    await waitFor(() => expect(storedNotice()).toBeUndefined());
    expect(
      screen.getByText("Grupo creado. Agrega a sus miembros."),
    ).toBeTruthy();
  });

  it("leaving an organization: Organizaciones shows the notice and clears it", async () => {
    let profile = adminProfile;
    mockTransport({
      ...baseRoutes([ada, carla]),
      "GET /api/v1/auth/profile": () => jsonResponse({ profile }),
      "DELETE /api/v1/organizations/org-1/memberships/user-1": () => {
        profile = profileFixture({ memberships: [] });
        return new Response(null, { status: 204 });
      },
    });
    renderApp({ route: "/organizations/org-1/members/user-1" });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar a Ada Lovelace de la organización",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Ada Lovelace" }),
    );

    await screen.findByText("Saliste de la organización «Academia Norte».");
    await waitFor(() => expect(storedNotice()).toBeUndefined());
    expect(
      screen.getByText("Saliste de la organización «Academia Norte»."),
    ).toBeTruthy();
  });
});
