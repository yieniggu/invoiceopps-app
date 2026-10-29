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
  deferred,
  errorResponse,
  groupMembershipsPage,
  jsonResponse,
  membership,
  mockTransport,
  NO_PERMISSIONS,
  orgMembershipsPage,
  profileFixture,
  serializeClient,
  usersPage,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const org = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia Norte",
};
const admin = profileFixture({ memberships: [membership(org, "ADMIN")] });
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
    permissions: NO_PERMISSIONS,
    groups: [
      {
        groupId: "00000000-0000-4000-a000-000000000097",
        name: "Equipo A",
        permissions: NO_PERMISSIONS,
      },
    ],
    user: {
      id: "00000000-0000-4000-8000-000000000003",
      name: "Carla Soto",
      rut: "190347907",
    },
  },
];

function baseRoutes() {
  return {
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: admin }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations": () =>
      jsonResponse({
        organizations: [
          {
            ...org,
            slug: "00000000-0000-4000-9000-000000000001",
            description: null,
            enabled: true,
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ],
        page: 1,
        pageSize: 100,
        total: 1,
      }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001": () =>
      jsonResponse({
        organization: {
          ...org,
          slug: "00000000-0000-4000-9000-000000000001",
          description: null,
        },
        summary: { memberCount: 2, groupCount: 1 },
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
              name: "Equipo A",
              description: null,
            },
          ],
        }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships":
      () =>
        jsonResponse(
          groupMembershipsPage([
            {
              userId: "00000000-0000-4000-8000-000000000003",
              groupId: "00000000-0000-4000-a000-000000000097",
              organizationId: "00000000-0000-4000-9000-000000000001",
              permissions: NO_PERMISSIONS,
              user: members[1].user,
            },
          ]),
        ),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
      () =>
        jsonResponse(
          usersPage(members.map(({ user, role }) => ({ ...user, role }))),
        ),
  };
}

/** Fills the data step and walks the wizard to its summary. */
async function fillWizard(name: string, rut: string) {
  fireEvent.change(screen.getByLabelText("Nombre completo"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText(/RUT del usuario/), {
    target: { value: rut },
  });
  fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
  await screen.findByRole("heading", { name: /Paso 2 de 4/ });
  fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
  await screen.findByRole("heading", { name: /Paso 3 de 4/ });
  fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
  await screen.findByRole("heading", { name: /Paso 4 de 4/ });
}

const MEMBERS = "/organizations/00000000-0000-4000-9000-000000000001/members";

/** Opens a person's own page as a deep link, like a reload would. */
async function openMemberPage(userId: string, name: string) {
  renderApp({ route: `${MEMBERS}/${userId}` });
  await screen.findByRole("heading", { level: 1, name });
}

/** Opens the "Crear persona nueva" tab of the add-member screen. */
async function openNewPerson(options: { route?: string } = {}) {
  const view = renderApp({ route: `${MEMBERS}/new`, ...options });
  await screen.findByRole("heading", { level: 1, name: "Agregar miembro" });
  fireEvent.click(screen.getByRole("tab", { name: "Crear persona nueva" }));
  return view;
}

describe("organization members (AC-11)", () => {
  it("lists members with canonical RUTs formatted for display", async () => {
    mockTransport(baseRoutes());
    renderApp({ route: MEMBERS });
    expect(await screen.findByText("Carla Soto")).toBeTruthy();
    expect(screen.getByText("19.034.790-7")).toBeTruthy();
    expect(screen.getByText("12.345.678-5")).toBeTruthy();
    // Role, groups and the permission summary travel in the same row.
    const row = screen.getByText("Carla Soto").closest("tr") as HTMLElement;
    expect(within(row).getByText("Usuario")).toBeTruthy();
    expect(within(row).getByText("Equipo A")).toBeTruthy();
    expect(within(row).getByText("0 de 4 permisos")).toBeTruthy();
  });

  it("changes a role with PATCH {role} and refetches only this organization's memberships", async () => {
    const transport = mockTransport({
      ...baseRoutes(),
      "PATCH /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/00000000-0000-4000-8000-000000000003":
        () =>
          jsonResponse({
            membership: {
              userId: "00000000-0000-4000-8000-000000000003",
              organizationId: "00000000-0000-4000-9000-000000000001",
              role: "ADMIN",
            },
          }),
    });
    await openMemberPage("00000000-0000-4000-8000-000000000003", "Carla Soto");
    const select = await screen.findByLabelText("Rol de Carla Soto");
    fireEvent.change(select, { target: { value: "ADMIN" } });
    await waitFor(() =>
      expect(
        transport.calls(
          "PATCH /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/00000000-0000-4000-8000-000000000003",
        ),
      ).toHaveLength(1),
    );
    expect(
      transport.calls(
        "PATCH /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/00000000-0000-4000-8000-000000000003",
      )[0].body,
    ).toEqual({ role: "ADMIN" });
    await waitFor(() =>
      expect(
        transport.calls(
          "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships",
        ),
      ).toHaveLength(2),
    );
    // Another person's role does not touch the profile.
    expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(1);
  });

  it("announces LAST_ADMIN_REQUIRED accessibly and keeps the role unchanged", async () => {
    mockTransport({
      ...baseRoutes(),
      "PATCH /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/00000000-0000-4000-8000-000000000001":
        () => errorResponse(409, "LAST_ADMIN_REQUIRED"),
    });
    await openMemberPage(
      "00000000-0000-4000-8000-000000000001",
      "Ada Lovelace",
    );
    const select = (await screen.findByLabelText(
      "Rol de Ada Lovelace",
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "USER" } });
    // Ada is the signed-in actor: her own role change asks first.
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirmar cambio de rol" }),
    );
    const alert = await screen.findByText(
      "No puedes quitar ni cambiar el rol del último administrador de la organización.",
    );
    expect(alert.getAttribute("role")).toBe("alert");
    expect(select.value).toBe("ADMIN");
  });

  it("removes a member with DELETE and refreshes the profile when the actor removes themselves", async () => {
    const transport = mockTransport({
      ...baseRoutes(),
      "DELETE /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/00000000-0000-4000-8000-000000000001":
        () => new Response(null, { status: 204 }),
    });
    await openMemberPage(
      "00000000-0000-4000-8000-000000000001",
      "Ada Lovelace",
    );
    const trigger = await screen.findByRole("button", {
      name: "Quitar a Ada Lovelace de la organización",
    });
    fireEvent.click(trigger);
    // Nothing is sent until the removal is confirmed.
    expect(
      transport.calls(
        "DELETE /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/00000000-0000-4000-8000-000000000001",
      ),
    ).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Ada Lovelace" }),
    );
    await waitFor(() =>
      expect(
        transport.calls(
          "DELETE /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/00000000-0000-4000-8000-000000000001",
        ),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(2),
    );
  });

  it("goes back to the members list with a status message after removing someone else", async () => {
    mockTransport({
      ...baseRoutes(),
      "DELETE /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/00000000-0000-4000-8000-000000000003":
        () => new Response(null, { status: 204 }),
    });
    await openMemberPage("00000000-0000-4000-8000-000000000003", "Carla Soto");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar a Carla Soto de la organización",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Carla Soto" }),
    );
    expect(
      await screen.findByText("Se quitó a Carla Soto de la organización."),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(MEMBERS);
  });

  it("CR-109 marks this organization's group memberships stale after a removal, not another organization's", async () => {
    const groupKey = (organizationId: string, groupId: string) => [
      "identity",
      "00000000-0000-4000-8000-000000000001",
      "org",
      organizationId,
      "group",
      groupId,
      "memberships",
    ];
    mockTransport({
      ...baseRoutes(),
      "DELETE /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/00000000-0000-4000-8000-000000000003":
        () => new Response(null, { status: 204 }),
    });
    const { store } = renderApp({
      route: `${MEMBERS}/00000000-0000-4000-8000-000000000003`,
    });
    await screen.findByRole("heading", { level: 1, name: "Carla Soto" });
    const client = store.getSnapshot().client;
    client.setQueryData(
      groupKey(
        "00000000-0000-4000-9000-000000000001",
        "00000000-0000-4000-a000-000000000122",
      ),
      { memberships: [] },
    );
    client.setQueryData(
      groupKey(
        "00000000-0000-4000-9000-000000000002",
        "00000000-0000-4000-a000-000000000122",
      ),
      { memberships: [] },
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Quitar a Carla Soto de la organización",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Confirmar quitar a Carla Soto" }),
    );

    await waitFor(() =>
      expect(
        client.getQueryState(
          groupKey(
            "00000000-0000-4000-9000-000000000001",
            "00000000-0000-4000-a000-000000000122",
          ),
        )?.isInvalidated,
      ).toBe(true),
    );
    expect(
      client.getQueryState(
        groupKey(
          "00000000-0000-4000-9000-000000000002",
          "00000000-0000-4000-a000-000000000122",
        ),
      )?.isInvalidated,
    ).toBe(false);
  });

  it("adds an existing person by RUT and goes back to the members list with a status message", async () => {
    const transport = mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
        () =>
          jsonResponse(
            {
              membership: {
                userId: "00000000-0000-4000-8000-000000000004",
                organizationId: "00000000-0000-4000-9000-000000000001",
                role: "USER",
              },
            },
            201,
          ),
    });
    renderApp({ route: `${MEMBERS}/new` });
    await screen.findByRole("heading", { level: 1, name: "Agregar miembro" });
    fireEvent.change(screen.getByLabelText(/RUT de la persona/), {
      target: { value: "190347907" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Agregar persona" }));
    await screen.findByText("Persona agregada a la organización.");
    expect(
      transport.calls(
        "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships",
      )[0].body,
    ).toEqual({
      rut: "19034790-7",
      role: "USER",
      permissions: NO_PERMISSIONS,
    });
    expect(window.location.pathname).toBe(MEMBERS);
    // The members table loads and the member count of the summary is stale.
    expect(await screen.findByText("Carla Soto")).toBeTruthy();
  });

  it("explains USER_NOT_FOUND for an unknown RUT", async () => {
    mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
        () => errorResponse(404, "USER_NOT_FOUND"),
    });
    renderApp({ route: `${MEMBERS}/new` });
    await screen.findByRole("heading", { level: 1, name: "Agregar miembro" });
    fireEvent.change(screen.getByLabelText(/RUT de la persona/), {
      target: { value: "190347907" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Agregar persona" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No existe una persona registrada con ese RUT.",
    );
    expect(window.location.pathname).toBe(`${MEMBERS}/new`);
  });
});

describe("user provisioning keeps the temporary password out of the cache (AC-11)", () => {
  const issued = "Tmp-Secret-4821-xyz";

  it("hands the secret to a dialog only, resolves metadata and resets the form", async () => {
    const gate = deferred<Response>();
    const transport = mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
        () => gate.promise,
    });
    const { store } = await openNewPerson();

    await fillWizard("Diego Rojas", "111111111");
    const create = screen.getByRole("button", { name: "Crear usuario" });
    fireEvent.click(create);
    // No duplicate submit: the control is disabled while the request is in
    // flight, and so is going back to edit what is being sent.
    await waitFor(() => expect(create).toHaveProperty("disabled", true));
    fireEvent.click(create);
    expect(screen.getByRole("button", { name: "Atrás" })).toHaveProperty(
      "disabled",
      true,
    );
    gate.resolve(
      jsonResponse(
        {
          user: {
            id: "00000000-0000-4000-8000-000000000009",
            name: "Diego Rojas",
            rut: "111111111",
            mustChangePassword: true,
          },
          membership: {
            userId: "00000000-0000-4000-8000-000000000009",
            organizationId: "00000000-0000-4000-9000-000000000001",
            role: "USER",
          },
          temporaryPassword: issued,
        },
        201,
      ),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Contraseña temporal",
    });
    expect(within(dialog).getByText(issued)).toBeTruthy();
    expect(
      transport.calls(
        "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/users",
      )[0].body,
    ).toEqual({
      name: "Diego Rojas",
      rut: "11111111-1",
      role: "USER",
      permissions: NO_PERMISSIONS,
      groups: [],
    });
    expect(
      transport.calls(
        "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/users",
      ),
    ).toHaveLength(1);
    expect(dialog.contains(document.activeElement)).toBe(true);

    const dump = serializeClient(store.getSnapshot().client);
    expect(dump).not.toContain(issued);
    expect(
      store.getSnapshot().client.getMutationCache().getAll(),
    ).not.toHaveLength(0);

    // The person lands on the members list (fresh read) with a status message.
    expect(
      await screen.findByText(
        "Usuario «Diego Rojas» creado y agregado a la organización. La persona deberá cambiar su contraseña temporal al iniciar sesión.",
      ),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(MEMBERS);
    await waitFor(() =>
      expect(
        transport.calls(
          "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships",
        ),
      ).toHaveLength(1),
    );
    // Navigation does not take focus away from the open dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Escape does not discard the only copy of the password: it moves focus to
    // the confirmation button, which is what closes the dialog.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Ya copié la contraseña" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Ya copié la contraseña" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(issued);
    expect(serializeClient(store.getSnapshot().client)).not.toContain(issued);
  });

  it("closes the dialog with its button and returns focus to the page title", async () => {
    mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
        () =>
          jsonResponse(
            {
              user: {
                id: "00000000-0000-4000-8000-000000000009",
                name: "Diego",
                rut: "111111111",
                mustChangePassword: true,
              },
              membership: {
                userId: "00000000-0000-4000-8000-000000000009",
                organizationId: "00000000-0000-4000-9000-000000000001",
                role: "USER",
              },
              temporaryPassword: issued,
            },
            201,
          ),
    });
    await openNewPerson();
    await fillWizard("Diego", "111111111");
    fireEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    const dialog = await screen.findByRole("dialog");
    // The dialog opens when the response arrives; the app moves to the members
    // list once its lists are fresh. Close it only after that move, or focus
    // would return to the page title of the screen that is about to leave.
    await screen.findByRole("heading", { level: 1, name: "Miembros" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Ya copié la contraseña" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // The form that opened the dialog is gone (the app moved to the members
    // list), so focus lands on the title of the page the person is on.
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 1, name: "Miembros" }),
    );
  });

  it("keeps Tab inside the dialog and labels it for assistive technology", async () => {
    mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
        () =>
          jsonResponse(
            {
              user: {
                id: "00000000-0000-4000-8000-000000000009",
                name: "Diego",
                rut: "111111111",
                mustChangePassword: true,
              },
              membership: {
                userId: "00000000-0000-4000-8000-000000000009",
                organizationId: "00000000-0000-4000-9000-000000000001",
                role: "USER",
              },
              temporaryPassword: issued,
            },
            201,
          ),
    });
    await openNewPerson();
    await fillWizard("Diego", "111111111");
    fireEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Contraseña temporal",
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const copy = within(dialog).getByRole("button", { name: "Copiar" });
    const close = within(dialog).getByRole("button", {
      name: "Ya copié la contraseña",
    });
    // Tab wraps from the last control to the first, and back with Shift+Tab.
    close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(copy);
    fireEvent.keyDown(copy, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it("blocks the submit for an invalid RUT, names the problem and focuses the field", async () => {
    const transport = mockTransport(baseRoutes());
    await openNewPerson();
    fireEvent.change(screen.getByLabelText("Nombre completo"), {
      target: { value: "Diego" },
    });
    const rut = screen.getByLabelText(/RUT del usuario/) as HTMLInputElement;
    fireEvent.change(rut, { target: { value: "190347908" } });
    expect(rut.value).toBe("19.034.790-8");
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(screen.getByText("RUT inválido")).toBeTruthy();
    expect(document.activeElement).toBe(rut);
    expect(
      transport.calls(
        "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/users",
      ),
    ).toHaveLength(0);
  });

  it("keeps the typed values and speaks Spanish on a network failure", async () => {
    mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
        () => {
          throw new TypeError("offline");
        },
    });
    await openNewPerson();
    await fillWizard("Diego", "111111111");
    fireEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /No fue posible conectar con el servidor/,
    );
    // Nothing was lost: the summary still shows what was typed.
    expect(screen.getByText("Diego")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks this organization's users stale after provisioning, leaving other organizations alone", async () => {
    mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
        () =>
          jsonResponse(
            {
              user: {
                id: "00000000-0000-4000-8000-000000000009",
                name: "Diego",
                rut: "111111111",
                mustChangePassword: true,
              },
              membership: {
                userId: "00000000-0000-4000-8000-000000000009",
                organizationId: "00000000-0000-4000-9000-000000000001",
                role: "USER",
              },
              temporaryPassword: "Tmp-Secret-1",
            },
            201,
          ),
    });
    const { store } = await openNewPerson();
    const client = store.getSnapshot().client;
    client.setQueryData(
      [
        "identity",
        "00000000-0000-4000-8000-000000000001",
        "org",
        "00000000-0000-4000-9000-000000000001",
        "users",
      ],
      [],
    );
    client.setQueryData(
      [
        "identity",
        "00000000-0000-4000-8000-000000000001",
        "org",
        "00000000-0000-4000-9000-000000000002",
        "users",
      ],
      [],
    );
    await fillWizard("Diego", "111111111");
    fireEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    await screen.findByRole("dialog");
    const stale = (org: string) =>
      client.getQueryState([
        "identity",
        "00000000-0000-4000-8000-000000000001",
        "org",
        org,
        "users",
      ])?.isInvalidated;
    await waitFor(() =>
      expect(stale("00000000-0000-4000-9000-000000000001")).toBe(true),
    );
    expect(stale("00000000-0000-4000-9000-000000000002")).toBe(false);
  });

  it("reports USER_CONFLICT without opening a dialog", async () => {
    mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
        () => errorResponse(409, "USER_CONFLICT"),
    });
    await openNewPerson();
    await fillWizard("Diego", "111111111");
    fireEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    // The wizard goes back to the data step and flags the RUT field.
    await screen.findByRole("heading", { name: /Paso 1 de 4/ });
    expect(
      await screen.findByText("Ya existe un usuario con ese RUT."),
    ).toBeTruthy();
    expect(
      (
        screen.getByLabelText(/RUT del usuario/) as HTMLInputElement
      ).getAttribute("aria-invalid"),
    ).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("CR-104 issued credential survives navigation within the identity", () => {
  const issued = "Tmp-Secret-4821-xyz";
  const created = () =>
    jsonResponse(
      {
        user: {
          id: "00000000-0000-4000-8000-000000000009",
          name: "Diego Rojas",
          rut: "111111111",
          mustChangePassword: true,
        },
        membership: {
          userId: "00000000-0000-4000-8000-000000000009",
          organizationId: "00000000-0000-4000-9000-000000000001",
          role: "USER",
        },
        temporaryPassword: issued,
      },
      201,
    );

  async function startPending() {
    const gate = deferred<Response>();
    mockTransport({
      ...baseRoutes(),
      "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
        () => gate.promise,
      "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }),
    });
    const view = await openNewPerson();
    await fillWizard("Diego Rojas", "111111111");
    fireEvent.click(screen.getByRole("button", { name: "Crear usuario" }));
    fireEvent.click(
      within(screen.getByRole("navigation")).getByRole("link", {
        name: "Mi perfil",
      }),
    );
    await screen.findByRole("heading", { name: "Mi perfil" });
    return { ...view, gate };
  }

  it("shows the password when the response arrives after leaving the screen", async () => {
    const { gate, store } = await startPending();
    gate.resolve(created());

    const dialog = await screen.findByRole("dialog", {
      name: "Contraseña temporal",
    });
    expect(within(dialog).getByText(issued)).toBeTruthy();
    expect(serializeClient(store.getSnapshot().client)).not.toContain(issued);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Ya copié la contraseña" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(issued);
  });

  it("clears the dialog on logout and ignores a response arriving afterwards", async () => {
    const { gate } = await startPending();
    gate.resolve(created());
    await screen.findByRole("dialog", { name: "Contraseña temporal" });

    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(issued);
  });

  it("never shows a password that arrives after logout", async () => {
    const { gate } = await startPending();
    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });

    await act(async () => gate.resolve(created()));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(issued);
  });
});
