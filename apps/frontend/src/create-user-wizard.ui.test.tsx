import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { emptyOrganization } from "./features/users/wizard/draft";
import { GroupsStep } from "./features/users/wizard/GroupsStep";
import { renderApp } from "./test/renderApp";
import { renderWithIdentity } from "./test/renderWithIdentity";
import {
  NO_PERMISSIONS,
  deferred,
  errorResponse,
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
  serializeClient,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const NEW_USER = "/admin/users/new";
const SECRET = "Tmp-Wizard-Secret-7731";
const north = { id: "org-1", name: "Academia Norte" };
const south = { id: "org-2", name: "Instituto Sur" };
const groupsOf: Record<string, Array<{ id: string; name: string }>> = {
  "org-1": [
    { id: "group-a", name: "Contabilidad" },
    { id: "group-b", name: "Ventas" },
  ],
  "org-2": [{ id: "group-c", name: "Operaciones" }],
};
const platform = profileFixture({
  id: "admin-1",
  name: "Admin Plataforma",
  isPlatformAdministrator: true,
  memberships: [],
});

function created(name = "Diego Rojas") {
  return jsonResponse(
    {
      user: { id: "user-9", name, rut: "111111111", mustChangePassword: true },
      memberships: [],
      temporaryPassword: SECRET,
    },
    201,
  );
}

function platformRoutes(
  overrides: Record<string, () => Response | Promise<Response>> = {},
) {
  return {
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: platform }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations": () =>
      jsonResponse({
        organizations: [north, south].map((org) => ({
          ...org,
          slug: org.id,
          description: null,
          enabled: true,
          createdAt: "2026-10-01T00:00:00.000Z",
        })),
      }),
    ...Object.fromEntries(
      Object.entries(groupsOf).map(([orgId, groups]) => [
        `GET /api/v1/organizations/${orgId}/groups`,
        () =>
          jsonResponse({
            groups: groups.map((group) => ({
              ...group,
              organizationId: orgId,
              description: null,
            })),
          }),
      ]),
    ),
    ...overrides,
  };
}

const press = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const heading = (text: RegExp) => screen.findByRole("heading", { name: text });

async function fillData(name = "Diego Rojas", rut = "111111111") {
  fireEvent.change(await screen.findByLabelText("Nombre completo"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText(/RUT del usuario/), {
    target: { value: rut },
  });
}
async function toStep2() {
  press("Siguiente");
  return heading(/Paso 2 de 4/);
}
async function toStep3() {
  press("Siguiente");
  return heading(/Paso 3 de 4/);
}
async function toSummary() {
  press("Siguiente");
  return heading(/Paso 4 de 4/);
}
const card = (index: number) =>
  screen.getByRole("region", { name: `Organización ${index}` });
const groupsOfOrganization = (name: string) =>
  screen.getByRole("region", { name: `Grupos de ${name}` });
const optionsOf = (select: HTMLElement) =>
  Array.from((select as HTMLSelectElement).options).map(
    (option) => option.text,
  );

/** Step 2: adds an organization card and picks the organization. */
function addOrganization(index: number, orgId: string) {
  press("Agregar a una organización");
  fireEvent.change(within(card(index)).getByLabelText("Organización"), {
    target: { value: orgId },
  });
}
/** Step 3: adds a group to the organization's section and picks it. */
async function addGroup(organizationName: string, groupId: string) {
  const section = within(groupsOfOrganization(organizationName));
  await waitFor(() =>
    expect(
      section.getByRole("button", { name: "Agregar a un grupo" }),
    ).toHaveProperty("disabled", false),
  );
  fireEvent.click(section.getByRole("button", { name: "Agregar a un grupo" }));
  const selects = section.getAllByLabelText("Grupo");
  fireEvent.change(selects[selects.length - 1], { target: { value: groupId } });
}

describe("Admin entry and route authority", () => {
  it("shows Admin above Mi perfil, after a divider, only to the platform administrator", async () => {
    mockTransport(platformRoutes());
    renderApp({ route: "/dashboard" });
    const nav = await screen.findByRole("navigation");
    const admin = within(nav).getByRole("link", { name: "Admin" });
    const profile = within(nav).getByRole("link", { name: "Mi perfil" });
    const separator = within(nav).getByRole("separator");
    expect(admin.getAttribute("href")).toBe("/admin");
    expect(
      admin.compareDocumentPosition(separator) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      separator.compareDocumentPosition(profile) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("never shows Admin to an organization ADMIN or a regular member", async () => {
    mockTransport(
      platformRoutes({
        "GET /api/v1/auth/profile": () =>
          jsonResponse({
            profile: profileFixture({
              memberships: [membership(north, "ADMIN")],
            }),
          }),
      }),
    );
    renderApp({ route: "/dashboard" });
    const nav = await screen.findByRole("navigation");
    expect(within(nav).queryByRole("link", { name: "Admin" })).toBeNull();
    expect(within(nav).queryByRole("separator")).toBeNull();
  });

  it.each(["/admin", NEW_USER, "/admin/otra-cosa"])(
    "answers %s with the not-found page for a non-platform user",
    async (route) => {
      const transport = mockTransport(
        platformRoutes({
          "GET /api/v1/auth/profile": () =>
            jsonResponse({
              profile: profileFixture({
                memberships: [membership(north, "ADMIN")],
              }),
            }),
        }),
      );
      renderApp({ route });
      expect(
        await screen.findByRole("heading", {
          level: 1,
          name: "Página no encontrada",
        }),
      ).toBeTruthy();
      expect(screen.queryByLabelText("Nombre completo")).toBeNull();
      expect(transport.calls("GET /api/v1/organizations")).toHaveLength(0);
    },
  );

  it("sends /admin to the create-user screen for the platform administrator", async () => {
    mockTransport(platformRoutes());
    renderApp({ route: "/admin" });
    await screen.findByRole("heading", { level: 1, name: "Crear usuario" });
    expect(window.location.pathname).toBe(NEW_USER);
  });
});

describe("platform create-user wizard", () => {
  it("builds the exact POST body for several organizations and groups with permissions", async () => {
    const transport = mockTransport(
      platformRoutes({ "POST /api/v1/admin/users": () => created() }),
    );
    renderApp({ route: NEW_USER });
    await fillData();
    expect((await toStep2()).textContent).toBe("Paso 2 de 4: Organizaciones");
    // Focus follows the step heading.
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: /Paso 2 de 4/ }),
    );

    addOrganization(1, "org-1");
    fireEvent.change(within(card(1)).getByLabelText("Rol en la organización"), {
      target: { value: "ADMIN" },
    });
    fireEvent.click(
      within(
        screen.getByRole("group", {
          name: "Permisos en la organización «Academia Norte» — Diego Rojas",
        }),
      ).getByRole("button", { name: "Leer facturas" }),
    );
    addOrganization(2, "org-2");

    expect((await toStep3()).textContent).toBe("Paso 3 de 4: Grupos");
    await addGroup("Academia Norte", "group-a");
    fireEvent.click(
      within(
        screen.getByRole("group", {
          name: "Permisos en el grupo «Contabilidad» — Diego Rojas",
        }),
      ).getByRole("button", { name: "Crear facturas" }),
    );
    await addGroup("Academia Norte", "group-b");
    fireEvent.click(
      within(
        screen.getByRole("group", {
          name: "Permisos en el grupo «Ventas» — Diego Rojas",
        }),
      ).getByRole("button", { name: "Eliminar facturas propias" }),
    );
    await addGroup("Instituto Sur", "group-c");

    await toSummary();
    // The summary reads back everything that will be sent.
    expect(screen.getByText("Diego Rojas")).toBeTruthy();
    expect(screen.getByText("11.111.111-1")).toBeTruthy();
    expect(
      screen.getByText("Generada automáticamente (se muestra una sola vez)"),
    ).toBeTruthy();
    expect(screen.getByText("Rol: Administrador")).toBeTruthy();
    expect(
      screen.getByText("Grupo Contabilidad: Puede crear facturas"),
    ).toBeTruthy();
    expect(
      screen.getByText("Grupo Ventas: Puede eliminar sus propias facturas"),
    ).toBeTruthy();
    expect(
      screen.getByText("Grupo Operaciones: Sin permisos sobre facturas"),
    ).toBeTruthy();

    press("Crear usuario");
    await screen.findByRole("dialog", { name: "Contraseña temporal" });
    expect(transport.calls("POST /api/v1/admin/users")).toHaveLength(1);
    expect(transport.calls("POST /api/v1/admin/users")[0].body).toEqual({
      name: "Diego Rojas",
      rut: "11111111-1",
      memberships: [
        {
          organizationId: "org-1",
          role: "ADMIN",
          permissions: { ...NO_PERMISSIONS, readInvoices: true },
          groups: [
            {
              groupId: "group-a",
              permissions: { ...NO_PERMISSIONS, createInvoices: true },
            },
            {
              groupId: "group-b",
              permissions: { ...NO_PERMISSIONS, deleteOwnInvoices: true },
            },
          ],
        },
        {
          organizationId: "org-2",
          role: "USER",
          permissions: NO_PERMISSIONS,
          groups: [{ groupId: "group-c", permissions: NO_PERMISSIONS }],
        },
      ],
    });
  });

  it("shows the four steps in the indicator", async () => {
    mockTransport(platformRoutes());
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    const steps = within(screen.getByRole("list", { name: "Pasos" }));
    expect(
      steps.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["1. Datos", "2. Organizaciones", "3. Grupos", "4. Resumen"]);
    expect(
      steps.getByText("2. Organizaciones").getAttribute("aria-current"),
    ).toBe("step");
    await toStep3();
    expect(steps.getByText("3. Grupos").getAttribute("aria-current")).toBe(
      "step",
    );
  });

  it("prevents duplicate organizations and groups, and offers only the chosen organization's groups", async () => {
    mockTransport(platformRoutes());
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    addOrganization(1, "org-1");
    expect(optionsOf(within(card(1)).getByLabelText("Organización"))).toEqual([
      "Selecciona una organización",
      "Academia Norte (org-1)",
      "Instituto Sur (org-2)",
    ]);
    press("Agregar a una organización");
    // The second card cannot pick the organization the first one holds.
    expect(optionsOf(within(card(2)).getByLabelText("Organización"))).toEqual([
      "Selecciona una organización",
      "Instituto Sur (org-2)",
    ]);
    // Once every organization is taken, the add button says why it is off.
    fireEvent.change(within(card(2)).getByLabelText("Organización"), {
      target: { value: "org-2" },
    });
    const add = screen.getByRole("button", {
      name: "Agregar a una organización",
    });
    expect(add).toHaveProperty("disabled", true);
    expect(
      screen.getByText("Ya agregaste todas las organizaciones disponibles."),
    ).toBeTruthy();
    expect(add.getAttribute("aria-describedby")).toBe(
      screen.getByText("Ya agregaste todas las organizaciones disponibles.").id,
    );

    await toStep3();
    // Groups: only this organization's, and not the one already added.
    await addGroup("Academia Norte", "");
    await addGroup("Academia Norte", "");
    const selects = within(
      groupsOfOrganization("Academia Norte"),
    ).getAllByLabelText("Grupo");
    expect(optionsOf(selects[0])).toEqual([
      "Selecciona un grupo",
      "Contabilidad",
      "Ventas",
    ]);
    expect(optionsOf(selects[1])).toEqual([
      "Selecciona un grupo",
      "Contabilidad",
      "Ventas",
    ]);
    fireEvent.change(selects[0], { target: { value: "group-a" } });
    expect(optionsOf(selects[1])).toEqual(["Selecciona un grupo", "Ventas"]);
    fireEvent.change(selects[1], { target: { value: "group-b" } });
    // Every group of the organization is taken: the button explains itself.
    const addGroupButton = within(
      groupsOfOrganization("Academia Norte"),
    ).getByRole("button", { name: "Agregar a un grupo" });
    expect(addGroupButton).toHaveProperty("disabled", true);
    expect(
      screen.getByText("Ya agregaste todos los grupos disponibles."),
    ).toBeTruthy();
    // The other organization only offers its own group.
    await addGroup("Instituto Sur", "");
    expect(
      optionsOf(
        within(groupsOfOrganization("Instituto Sur")).getByLabelText("Grupo"),
      ),
    ).toEqual(["Selecciona un grupo", "Operaciones"]);
  });

  it("drops the groups of an organization when another one is chosen, and removes rows", async () => {
    mockTransport(platformRoutes());
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    addOrganization(1, "org-1");
    await toStep3();
    await addGroup("Academia Norte", "group-a");
    expect(
      within(groupsOfOrganization("Academia Norte")).getAllByLabelText("Grupo"),
    ).toHaveLength(1);
    press("Atrás");
    fireEvent.change(within(card(1)).getByLabelText("Organización"), {
      target: { value: "org-2" },
    });
    await toStep3();
    expect(
      within(groupsOfOrganization("Instituto Sur")).queryAllByLabelText(
        "Grupo",
      ),
    ).toHaveLength(0);
    await addGroup("Instituto Sur", "group-c");
    fireEvent.click(
      within(groupsOfOrganization("Instituto Sur")).getByRole("button", {
        name: "Quitar grupo Operaciones de Instituto Sur",
      }),
    );
    expect(
      within(groupsOfOrganization("Instituto Sur")).queryAllByLabelText(
        "Grupo",
      ),
    ).toHaveLength(0);
    press("Atrás");
    fireEvent.click(
      screen.getByRole("button", { name: "Quitar organización Instituto Sur" }),
    );
    expect(screen.queryByRole("region", { name: /Organización 1/ })).toBeNull();
    await toStep3();
    expect(
      screen.getByText("Sin organizaciones seleccionadas; puedes continuar."),
    ).toBeTruthy();
  });

  it("shows an empty state for an organization without groups and for no organizations", async () => {
    mockTransport(
      platformRoutes({
        "GET /api/v1/organizations/org-2/groups": () =>
          jsonResponse({ groups: [] }),
      }),
    );
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    await toStep3();
    expect(
      screen.getByText("Sin organizaciones seleccionadas; puedes continuar."),
    ).toBeTruthy();
    press("Atrás");
    addOrganization(1, "org-2");
    await toStep3();
    expect(
      await screen.findByText("Esta organización no tiene grupos."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Agregar a un grupo" }),
    ).toBeNull();
  });

  it("folds organization cards behind a chevron with a one-line summary", async () => {
    mockTransport(platformRoutes());
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    addOrganization(1, "org-1");
    fireEvent.click(
      within(
        screen.getByRole("group", {
          name: "Permisos en la organización «Academia Norte» — Diego Rojas",
        }),
      ).getByRole("button", { name: "Leer facturas" }),
    );
    fireEvent.click(
      within(
        screen.getByRole("group", {
          name: "Permisos en la organización «Academia Norte» — Diego Rojas",
        }),
      ).getByRole("button", { name: "Crear facturas" }),
    );
    const toggle = within(card(1)).getByRole("button", {
      name: "Organización 1",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const bodyId = toggle.getAttribute("aria-controls") as string;
    expect(document.getElementById(bodyId)).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(bodyId)?.hasAttribute("hidden")).toBe(true);
    expect(
      screen.getByText("Academia Norte · Usuario · 2 permisos"),
    ).toBeTruthy();
    // Adding another organization folds this one and opens the new one.
    press("Agregar a una organización");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      within(card(2))
        .getByRole("button", { name: "Organización 2" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("summarizes an organization without permissions and names it in the remove button", async () => {
    mockTransport(platformRoutes());
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    addOrganization(1, "org-1");
    fireEvent.click(
      within(card(1)).getByRole("button", { name: "Organización 1" }),
    );
    expect(
      screen.getByText("Academia Norte · Usuario · sin permisos"),
    ).toBeTruthy();
    expect(
      within(card(1)).getByRole("button", {
        name: "Quitar organización Academia Norte",
      }).textContent,
    ).toBe("Quitar organización");
  });

  it("validates each step with accessible messages and focus, and Atrás keeps the data", async () => {
    const transport = mockTransport(platformRoutes());
    renderApp({ route: NEW_USER });
    const name = await screen.findByLabelText("Nombre completo");
    press("Siguiente");
    expect(screen.getByText("Ingresa el nombre completo.")).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: "Diego Rojas" } });
    const rut = screen.getByLabelText(/RUT del usuario/);
    fireEvent.change(rut, { target: { value: "111111112" } });
    press("Siguiente");
    expect(screen.getByText("RUT inválido")).toBeTruthy();
    expect(document.activeElement).toBe(rut);
    fireEvent.change(rut, { target: { value: "111111111" } });
    await toStep2();

    press("Agregar a una organización");
    press("Siguiente");
    const select = within(card(1)).getByLabelText("Organización");
    expect(screen.getByText("Selecciona una organización.")).toBeTruthy();
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(select);
    fireEvent.change(select, { target: { value: "org-1" } });
    await toStep3();
    const section = within(groupsOfOrganization("Academia Norte"));
    await waitFor(() =>
      expect(
        section.getByRole("button", { name: "Agregar a un grupo" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(
      section.getByRole("button", { name: "Agregar a un grupo" }),
    );
    press("Siguiente");
    expect(screen.getByText("Selecciona un grupo.")).toBeTruthy();
    expect(document.activeElement).toBe(section.getByLabelText("Grupo"));

    // Atrás returns step by step, focused on the heading, data intact.
    press("Atrás");
    press("Atrás");
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: /Paso 1 de 4/ }),
    );
    expect(
      (screen.getByLabelText("Nombre completo") as HTMLInputElement).value,
    ).toBe("Diego Rojas");
    expect(transport.calls("POST /api/v1/admin/users")).toHaveLength(0);
  });

  it("expands a folded organization or group that has errors when trying to advance", async () => {
    mockTransport(platformRoutes());
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    // The first card stays without an organization and gets folded.
    press("Agregar a una organización");
    press("Agregar a una organización");
    const first = within(card(1)).getByRole("button", {
      name: "Organización 1",
    });
    expect(first.getAttribute("aria-expanded")).toBe("false");
    fireEvent.change(within(card(2)).getByLabelText("Organización"), {
      target: { value: "org-2" },
    });
    press("Siguiente");
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(
      within(card(1)).getByLabelText("Organización"),
    );
    fireEvent.change(within(card(1)).getByLabelText("Organización"), {
      target: { value: "org-1" },
    });
    await toStep3();
    // A group left empty and then folded reopens on the next attempt.
    await addGroup("Academia Norte", "");
    await addGroup("Academia Norte", "group-a");
    const folded = within(groupsOfOrganization("Academia Norte")).getByRole(
      "button",
      { name: "Grupo 1" },
    );
    expect(folded.getAttribute("aria-expanded")).toBe("false");
    press("Siguiente");
    expect(folded.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(
      within(groupsOfOrganization("Academia Norte")).getAllByLabelText(
        "Grupo",
      )[0],
    );
    // Whole organization sections fold too.
    const sectionToggle = screen.getByRole("button", {
      name: "Grupos de Academia Norte",
    });
    fireEvent.click(sectionToggle);
    expect(sectionToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Academia Norte · 2 grupos")).toBeTruthy();
    press("Siguiente");
    expect(sectionToggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("allows creating a user without organizations", async () => {
    const transport = mockTransport(
      platformRoutes({ "POST /api/v1/admin/users": () => created() }),
    );
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    expect(screen.getByText(/Aún no agregaste organizaciones/)).toBeTruthy();
    await toStep3();
    expect(
      screen.getByText("Sin organizaciones seleccionadas; puedes continuar."),
    ).toBeTruthy();
    await toSummary();
    expect(screen.getByText(/Sin organizaciones/)).toBeTruthy();
    press("Crear usuario");
    await screen.findByRole("dialog");
    expect(transport.calls("POST /api/v1/admin/users")[0].body).toEqual({
      name: "Diego Rojas",
      rut: "11111111-1",
      memberships: [],
    });
  });

  it("explains that there are no organizations and links to creating one", async () => {
    mockTransport(
      platformRoutes({
        "GET /api/v1/organizations": () => jsonResponse({ organizations: [] }),
      }),
    );
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    expect(screen.getByText("Todavía no hay organizaciones.")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Crear organización" })
        .getAttribute("href"),
    ).toBe("/organizations/new");
    expect(
      screen.queryByRole("button", { name: "Agregar a una organización" }),
    ).toBeNull();
  });

  it("maps a duplicate RUT (409) to the RUT field and returns to step 1", async () => {
    mockTransport(
      platformRoutes({
        "POST /api/v1/admin/users": () => errorResponse(409, "USER_CONFLICT"),
      }),
    );
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    await toStep3();
    await toSummary();
    press("Crear usuario");
    await heading(/Paso 1 de 4/);
    expect(
      await screen.findByText("Ya existe un usuario con ese RUT."),
    ).toBeTruthy();
    const rut = screen.getByLabelText(/RUT del usuario/);
    expect(rut.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: /Paso 1 de 4/ }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // Editing the RUT retires the server message.
    fireEvent.change(rut, { target: { value: "190347907" } });
    await waitFor(() =>
      expect(
        screen.queryByText("Ya existe un usuario con ese RUT."),
      ).toBeNull(),
    );
  });

  it("explains a vanished organization or group (404) on step 2 and refreshes the choices", async () => {
    const transport = mockTransport(
      platformRoutes({
        "POST /api/v1/admin/users": () => errorResponse(404, "NOT_FOUND"),
      }),
    );
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    addOrganization(1, "org-1");
    await toStep3();
    await toSummary();
    const reads = transport.calls("GET /api/v1/organizations").length;
    press("Crear usuario");
    await heading(/Paso 2 de 4/);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Una organización o un grupo elegido ya no existe. Revisa la selección e intenta nuevamente.",
    );
    await waitFor(() =>
      expect(
        transport.calls("GET /api/v1/organizations").length,
      ).toBeGreaterThan(reads),
    );
  });

  it.each([
    ["name", { name: "required" }, /Paso 1 de 4/, "Revisa el nombre completo."],
    [
      "temporaryPassword",
      { temporaryPassword: "too short" },
      /Paso 1 de 4/,
      undefined,
    ],
    [
      "memberships.0.organizationId",
      { "memberships.0.organizationId": "invalid" },
      /Paso 2 de 4/,
      undefined,
    ],
    [
      "memberships.0.groups.0.groupId",
      { "memberships.0.groups.0.groupId": "invalid" },
      /Paso 3 de 4/,
      undefined,
    ],
    ["anything else", { body: "invalid" }, /Paso 4 de 4/, undefined],
  ])(
    "maps a server field error (400) on %s to its step",
    async (_label, fields, expectedStep, message) => {
      mockTransport(
        platformRoutes({
          "POST /api/v1/admin/users": () =>
            errorResponse(400, "VALIDATION_ERROR", fields),
        }),
      );
      renderApp({ route: NEW_USER });
      await fillData();
      await toStep2();
      await toStep3();
      await toSummary();
      press("Crear usuario");
      await heading(expectedStep);
      if (message) expect(screen.getByText(message)).toBeTruthy();
    },
  );

  it("sends one request when the create button is pressed again while pending", async () => {
    const gate = deferred<Response>();
    const transport = mockTransport(
      platformRoutes({ "POST /api/v1/admin/users": () => gate.promise }),
    );
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    await toStep3();
    await toSummary();
    const create = screen.getByRole("button", { name: "Crear usuario" });
    fireEvent.click(create);
    await waitFor(() => expect(create).toHaveProperty("disabled", true));
    fireEvent.click(create);
    fireEvent.submit(create.closest("form") as HTMLFormElement);
    expect(screen.getByRole("button", { name: "Atrás" })).toHaveProperty(
      "disabled",
      true,
    );
    await act(async () => gate.resolve(created()));
    await screen.findByRole("dialog");
    expect(transport.calls("POST /api/v1/admin/users")).toHaveLength(1);
  });

  it("keeps the temporary password out of caches and storage, and offers another user", async () => {
    mockTransport(
      platformRoutes({ "POST /api/v1/admin/users": () => created() }),
    );
    const { store } = renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    await toStep3();
    await toSummary();
    press("Crear usuario");
    const dialog = await screen.findByRole("dialog", {
      name: "Contraseña temporal",
    });
    expect(within(dialog).getByText(SECRET)).toBeTruthy();
    const client = store.getSnapshot().client;
    expect(serializeClient(client)).not.toContain(SECRET);
    expect(client.getMutationCache().getAll()).not.toHaveLength(0);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(SECRET);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Ya copié la contraseña" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
    // Focus returns to the control that replaced the submit button.
    const another = screen.getByRole("button", { name: "Crear otro usuario" });
    expect(document.activeElement).toBe(another);
    expect(serializeClient(client)).not.toContain(SECRET);

    fireEvent.click(another);
    expect(
      (screen.getByLabelText("Nombre completo") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByRole("heading", { name: /Paso 1 de 4/ })).toBeTruthy();
  });

  it("refreshes the organization list and only the affected organizations' people", async () => {
    const transport = mockTransport(
      platformRoutes({ "POST /api/v1/admin/users": () => created() }),
    );
    const { store } = renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    addOrganization(1, "org-1");
    await toStep3();
    await addGroup("Academia Norte", "group-a");
    await toSummary();
    const listReads = transport.calls("GET /api/v1/organizations").length;
    const client = store.getSnapshot().client;
    const key = (...parts: string[]) => ["identity", "admin-1", ...parts];
    const seeded = [
      key("org", "org-1", "memberships"),
      key("org", "org-1", "users"),
      key("org", "org-1", "group", "group-a", "memberships"),
      key("org", "org-1", "group", "group-b", "memberships"),
      key("org", "org-2", "memberships"),
      key("org", "org-2", "users"),
    ];
    for (const queryKey of seeded) client.setQueryData(queryKey, []);
    press("Crear usuario");
    await screen.findByRole("dialog");
    const stale = (queryKey: string[]) =>
      client.getQueryState(queryKey)?.isInvalidated;
    await waitFor(() => expect(stale(seeded[0])).toBe(true));
    expect(stale(seeded[1])).toBe(true);
    expect(stale(seeded[2])).toBe(true);
    // The mounted organization list is refetched right away.
    await waitFor(() =>
      expect(
        transport.calls("GET /api/v1/organizations").length,
      ).toBeGreaterThan(listReads),
    );
    expect(stale(seeded[3])).toBe(false);
    expect(stale(seeded[4])).toBe(false);
    expect(stale(seeded[5])).toBe(false);
  });

  it("preselects the organization from ?organizationId when it is in the list, and ignores unknown ones", async () => {
    mockTransport(platformRoutes());
    renderApp({ route: `${NEW_USER}?organizationId=org-2` });
    await fillData();
    await toStep2();
    expect(
      (within(card(1)).getByLabelText("Organización") as HTMLSelectElement)
        .value,
    ).toBe("org-2");
    // The preselected card starts open.
    expect(
      within(card(1))
        .getByRole("button", { name: "Organización 1" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    cleanup();

    mockTransport(platformRoutes());
    renderApp({ route: `${NEW_USER}?organizationId=org-desconocida` });
    await fillData();
    await toStep2();
    expect(screen.queryByRole("region", { name: "Organización 1" })).toBeNull();
    expect(screen.getByText(/Aún no agregaste organizaciones/)).toBeTruthy();
  });

  it("offers a retry when the organizations cannot be loaded", async () => {
    let fails = true;
    mockTransport(
      platformRoutes({
        "GET /api/v1/organizations": () =>
          fails
            ? errorResponse(500, "INTERNAL")
            : jsonResponse({ organizations: [] }),
      }),
    );
    renderApp({ route: NEW_USER });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No fue posible cargar las organizaciones.",
    );
    fails = false;
    press("Reintentar organizaciones");
    expect(await screen.findByLabelText("Nombre completo")).toBeTruthy();
  });

  it("keeps the wizard and the draft when a later refresh of the organizations fails", async () => {
    let fails = false;
    const transport = mockTransport(
      platformRoutes({
        "GET /api/v1/organizations": () =>
          fails
            ? errorResponse(500, "INTERNAL")
            : jsonResponse({ organizations: [north, south] }),
      }),
    );
    const { store } = renderApp({ route: NEW_USER });
    await fillData("Diego Rojas", "111111111");
    const reads = transport.calls("GET /api/v1/organizations").length;
    fails = true;
    void store
      .getSnapshot()
      .client.invalidateQueries({ queryKey: ["identity", "admin-1", "orgs"] });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/No fue posible actualizar/);
    expect(transport.calls("GET /api/v1/organizations").length).toBeGreaterThan(
      reads,
    );
    // The draft survived: the wizard was never unmounted.
    expect(
      (screen.getByLabelText("Nombre completo") as HTMLInputElement).value,
    ).toBe("Diego Rojas");
    fails = false;
    press("Reintentar organizaciones");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(
      (screen.getByLabelText("Nombre completo") as HTMLInputElement).value,
    ).toBe("Diego Rojas");
  });
});

describe("temporary password choice", () => {
  const DEFINED = "Defined-Secret-4455";
  const radio = (name: string) => screen.getByRole("radio", { name });

  function definedCreated() {
    return jsonResponse(
      {
        user: {
          id: "user-9",
          name: "Diego Rojas",
          rut: "111111111",
          mustChangePassword: true,
        },
        memberships: [],
      },
      201,
    );
  }

  it("generates automatically by default and explains it", async () => {
    mockTransport(platformRoutes());
    renderApp({ route: NEW_USER });
    await fillData();
    expect(
      screen.getByRole("group", { name: "Contraseña temporal" }),
    ).toBeTruthy();
    expect(radio("Generar automáticamente")).toHaveProperty("checked", true);
    expect(radio("Definir contraseña temporal")).toHaveProperty(
      "checked",
      false,
    );
    expect(screen.queryByLabelText("Repetir contraseña")).toBeNull();
    expect(screen.getByText(/Se genera una contraseña temporal/)).toBeTruthy();
  });

  it("validates length and match before leaving step 1", async () => {
    mockTransport(platformRoutes());
    renderApp({ route: NEW_USER });
    await fillData();
    fireEvent.click(radio("Definir contraseña temporal"));
    const password = screen.getByLabelText("Contraseña");
    const repeat = screen.getByLabelText("Repetir contraseña");
    expect(password.getAttribute("autocomplete")).toBe("new-password");
    fireEvent.change(password, { target: { value: "x".repeat(7) } });
    fireEvent.change(repeat, { target: { value: "x".repeat(7) } });
    press("Siguiente");
    expect(
      screen.getByText(
        "La contraseña temporal debe tener entre 8 y 256 caracteres.",
      ),
    ).toBeTruthy();
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(password);

    fireEvent.change(password, { target: { value: "x".repeat(257) } });
    press("Siguiente");
    expect(
      screen.getByText(
        "La contraseña temporal debe tener entre 8 y 256 caracteres.",
      ),
    ).toBeTruthy();

    fireEvent.change(password, { target: { value: "x".repeat(256) } });
    fireEvent.change(repeat, { target: { value: "x".repeat(255) } });
    press("Siguiente");
    expect(screen.getByText("Las contraseñas no coinciden.")).toBeTruthy();
    expect(repeat.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(repeat);

    fireEvent.change(password, { target: { value: "x".repeat(8) } });
    fireEvent.change(repeat, { target: { value: "x".repeat(8) } });
    await toStep2();
  });

  it("sends the defined password, shows the choice (never the value) and confirms without a dialog", async () => {
    const transport = mockTransport(
      platformRoutes({ "POST /api/v1/admin/users": () => definedCreated() }),
    );
    const { store } = renderApp({ route: NEW_USER });
    await fillData();
    fireEvent.click(radio("Definir contraseña temporal"));
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: DEFINED },
    });
    fireEvent.change(screen.getByLabelText("Repetir contraseña"), {
      target: { value: DEFINED },
    });
    await toStep2();
    await toStep3();
    await toSummary();
    expect(screen.getByText("Definida por ti (no se muestra)")).toBeTruthy();
    expect(document.body.textContent).not.toContain(DEFINED);

    press("Crear usuario");
    expect((await screen.findByRole("status")).textContent).toBe(
      "Se creó a Diego Rojas. La persona deberá cambiarla al iniciar sesión.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(transport.calls("POST /api/v1/admin/users")[0].body).toEqual({
      name: "Diego Rojas",
      rut: "11111111-1",
      memberships: [],
      temporaryPassword: DEFINED,
    });
    expect(document.body.textContent).not.toContain(DEFINED);

    // Sentinel: the defined password is in no cache, variable or storage.
    const client = store.getSnapshot().client;
    expect(serializeClient(client)).not.toContain(DEFINED);
    const mutations = client.getMutationCache().getAll();
    expect(mutations).not.toHaveLength(0);
    for (const mutation of mutations) {
      expect(JSON.stringify(mutation.state.variables)).not.toContain(DEFINED);
      expect(JSON.stringify(mutation.state.data ?? null)).not.toContain(
        DEFINED,
      );
      expect(
        JSON.stringify(mutation.options.mutationKey ?? null),
      ).not.toContain(DEFINED);
    }
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(DEFINED);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(DEFINED);

    // Another user starts from a clean draft: generated, no leftover value.
    fireEvent.click(screen.getByRole("button", { name: "Crear otro usuario" }));
    expect(radio("Generar automáticamente")).toHaveProperty("checked", true);
    fireEvent.click(radio("Definir contraseña temporal"));
    expect(
      (screen.getByLabelText("Contraseña") as HTMLInputElement).value,
    ).toBe("");
  });

  it("does not send a password when the admin switches back to generating one", async () => {
    const transport = mockTransport(
      platformRoutes({ "POST /api/v1/admin/users": () => created() }),
    );
    renderApp({ route: NEW_USER });
    await fillData();
    fireEvent.click(radio("Definir contraseña temporal"));
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: DEFINED },
    });
    fireEvent.click(radio("Generar automáticamente"));
    await toStep2();
    await toStep3();
    await toSummary();
    press("Crear usuario");
    await screen.findByRole("dialog", { name: "Contraseña temporal" });
    expect(
      transport.calls("POST /api/v1/admin/users")[0].body,
    ).not.toHaveProperty("temporaryPassword");
  });

  it("shows the server's password-length rejection on the password field", async () => {
    mockTransport(
      platformRoutes({
        "POST /api/v1/admin/users": () =>
          errorResponse(400, "VALIDATION_ERROR", {
            temporaryPassword: "too short",
          }),
      }),
    );
    renderApp({ route: NEW_USER });
    await fillData();
    fireEvent.click(radio("Definir contraseña temporal"));
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: DEFINED },
    });
    fireEvent.change(screen.getByLabelText("Repetir contraseña"), {
      target: { value: DEFINED },
    });
    await toStep2();
    await toStep3();
    await toSummary();
    press("Crear usuario");
    await heading(/Paso 1 de 4/);
    expect(
      screen.getByText(
        "La contraseña temporal debe tener entre 8 y 256 caracteres.",
      ),
    ).toBeTruthy();
  });

  it("keeps the defined password out of the cache when the request fails", async () => {
    mockTransport(
      platformRoutes({
        "POST /api/v1/admin/users": () => errorResponse(409, "USER_CONFLICT"),
      }),
    );
    const { store } = renderApp({ route: NEW_USER });
    await fillData();
    fireEvent.click(radio("Definir contraseña temporal"));
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: DEFINED },
    });
    fireEvent.change(screen.getByLabelText("Repetir contraseña"), {
      target: { value: DEFINED },
    });
    await toStep2();
    await toStep3();
    await toSummary();
    press("Crear usuario");
    await heading(/Paso 1 de 4/);
    expect(serializeClient(store.getSnapshot().client)).not.toContain(DEFINED);
    // The typed value is kept so the admin can fix the RUT and retry.
    expect(
      (screen.getByLabelText("Contraseña") as HTMLInputElement).value,
    ).toBe(DEFINED);
  });
});

/** The single-organization wizard lives in a tab of the add-member screen. */
async function openOrganizationWizard() {
  const view = renderApp({ route: "/organizations/org-1/members/new" });
  await screen.findByRole("heading", { level: 1, name: "Agregar miembro" });
  fireEvent.click(screen.getByRole("tab", { name: "Crear persona nueva" }));
  return view;
}

describe("single-organization mode on the add-member screen", () => {
  const admin = profileFixture({
    memberships: [membership(north, "ADMIN")],
  });
  const routes = (post: () => Response) => ({
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: admin }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations": () => jsonResponse({ organizations: [] }),
    "GET /api/v1/organizations/org-1/memberships": () =>
      jsonResponse({ memberships: [] }),
    "GET /api/v1/organizations/org-1/users": () => jsonResponse({ users: [] }),
    "GET /api/v1/organizations/org-1/groups": () =>
      jsonResponse({
        groups: groupsOf["org-1"].map((group) => ({
          ...group,
          organizationId: "org-1",
          description: null,
        })),
      }),
    "POST /api/v1/organizations/org-1/users": post,
  });

  it("fixes the organization, shows only its role, permissions and groups, and posts the organization body", async () => {
    const transport = mockTransport(
      routes(() =>
        jsonResponse(
          {
            user: { id: "user-9", name: "Diego Rojas", rut: "111111111" },
            membership: {},
            groups: [],
            temporaryPassword: SECRET,
          },
          201,
        ),
      ),
    );
    await openOrganizationWizard();
    await fillData();
    expect((await toStep2()).textContent).toBe("Paso 2 de 4: Rol y permisos");
    // No organization picker and no way to add or remove organizations.
    expect(screen.queryByLabelText("Organización")).toBeNull();
    expect(screen.queryByRole("button", { name: /organización/i })).toBeNull();
    const only = screen.getByRole("region", {
      name: "Organización Academia Norte",
    });
    fireEvent.change(within(only).getByLabelText("Rol en la organización"), {
      target: { value: "ADMIN" },
    });
    fireEvent.click(
      within(only).getByRole("button", { name: "Crear facturas" }),
    );
    expect((await toStep3()).textContent).toBe("Paso 3 de 4: Grupos");
    await addGroup("Academia Norte", "");
    const groups = within(groupsOfOrganization("Academia Norte"));
    // Only this organization's groups are offered.
    expect(optionsOf(groups.getByLabelText("Grupo"))).toEqual([
      "Selecciona un grupo",
      "Contabilidad",
      "Ventas",
    ]);
    fireEvent.change(groups.getByLabelText("Grupo"), {
      target: { value: "group-b" },
    });
    fireEvent.click(
      within(
        screen.getByRole("group", {
          name: "Permisos en el grupo «Ventas» — Diego Rojas",
        }),
      ).getByRole("button", { name: "Leer facturas" }),
    );
    await toSummary();
    press("Crear usuario");
    await screen.findByRole("dialog", { name: "Contraseña temporal" });
    expect(
      transport.calls("POST /api/v1/organizations/org-1/users")[0].body,
    ).toEqual({
      name: "Diego Rojas",
      rut: "11111111-1",
      role: "ADMIN",
      permissions: { ...NO_PERMISSIONS, createInvoices: true },
      groups: [
        {
          groupId: "group-b",
          permissions: { ...NO_PERMISSIONS, readInvoices: true },
        },
      ],
    });
    expect(transport.calls("POST /api/v1/admin/users")).toHaveLength(0);
  });

  it("sends an admin-defined temporary password in the organization body and keeps it out of the cache", async () => {
    const DEFINED = "Org-Defined-Secret-9921";
    const transport = mockTransport(
      routes(() =>
        jsonResponse(
          {
            user: { id: "user-9", name: "Diego Rojas", rut: "111111111" },
            membership: {},
            groups: [],
          },
          201,
        ),
      ),
    );
    const { store } = await openOrganizationWizard();
    await fillData();
    fireEvent.click(
      screen.getByRole("radio", { name: "Definir contraseña temporal" }),
    );
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: DEFINED },
    });
    fireEvent.change(screen.getByLabelText("Repetir contraseña"), {
      target: { value: DEFINED },
    });
    await toStep2();
    await toStep3();
    await toSummary();
    press("Crear usuario");
    // No password to show: the person goes back to the members list, told that
    // the temporary password must be changed at the first login.
    await screen.findByText(
      /La persona deberá cambiar su contraseña temporal al iniciar sesión/,
    );
    expect(window.location.pathname).toBe("/organizations/org-1/members");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      transport.calls("POST /api/v1/organizations/org-1/users")[0].body,
    ).toEqual({
      name: "Diego Rojas",
      rut: "11111111-1",
      role: "USER",
      permissions: NO_PERMISSIONS,
      groups: [],
      temporaryPassword: DEFINED,
    });
    expect(serializeClient(store.getSnapshot().client)).not.toContain(DEFINED);
    expect(document.body.textContent).not.toContain(DEFINED);
  });
});

describe("identity switch", () => {
  it("leaves nothing of the platform administrator's wizard or organizations for the next person", async () => {
    let signedIn: "admin" | "other" = "admin";
    const other = profileFixture({
      id: "user-2",
      name: "Bruno Díaz",
      rut: "111111111",
      memberships: [],
    });
    mockTransport({
      ...platformRoutes({
        "GET /api/v1/auth/profile": () =>
          jsonResponse({ profile: signedIn === "admin" ? platform : other }),
      }),
      "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }),
      "POST /api/v1/auth/login": () => {
        signedIn = "other";
        return jsonResponse({ user: {} });
      },
    });
    const { store } = renderApp({ route: NEW_USER });
    await fillData("Persona A Secreta");
    await toStep2();
    addOrganization(1, "org-1");
    await toStep3();
    await addGroup("Academia Norte", "group-a");
    const clientOfAdmin = store.getSnapshot().client;
    expect(serializeClient(clientOfAdmin)).toContain("Academia Norte");

    fireEvent.click(screen.getByRole("button", { name: "Salir" }));
    await screen.findByRole("heading", { name: "Iniciar sesión" });
    fireEvent.change(screen.getByRole("textbox", { name: "RUT" }), {
      target: { value: "111111111" },
    });
    fireEvent.change(screen.getByLabelText("Contraseña"), {
      target: { value: "another-password-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    await screen.findByText(/Bruno Díaz/);

    const clientOfOther = store.getSnapshot().client;
    expect(clientOfOther).not.toBe(clientOfAdmin);
    // The retired partition was emptied...
    expect(clientOfAdmin.getQueryCache().getAll()).toHaveLength(0);
    expect(clientOfAdmin.getMutationCache().getAll()).toHaveLength(0);
    // ...and the next person sees and holds none of it.
    const dump = serializeClient(clientOfOther);
    for (const leaked of [
      "Academia Norte",
      "Instituto Sur",
      "Contabilidad",
      "admin-1",
    ])
      expect(dump).not.toContain(leaked);
    for (const leaked of [
      "Academia Norte",
      "Persona A Secreta",
      "Contabilidad",
    ])
      expect(document.body.textContent).not.toContain(leaked);
    expect(
      within(screen.getByRole("navigation")).queryByRole("link", {
        name: "Admin",
      }),
    ).toBeNull();
    expect(window.location.pathname).toBe("/dashboard");
  });
});

describe("groups that are not loaded do not pass (CR-258)", () => {
  const NOT_LOADED =
    "Los grupos de esta organización aún no se cargan. Espera o reintenta antes de continuar.";
  const GROUPS = "GET /api/v1/organizations/org-1/groups";

  /** Empties the cached groups and re-reads them (the failing read). */
  async function forgetGroups(client: QueryClient) {
    const queryKey = ["identity", "admin-1", "org", "org-1", "groups"];
    await act(async () => {
      await client.resetQueries({ queryKey });
    });
    await waitFor(() =>
      expect(client.getQueryState(queryKey)?.status).toBe("error"),
    );
    // Query observers tell React on a zero-delay timer: let it run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("blocks Siguiente on step 3 while a chosen group's list is not loaded, then lets it pass once loaded", async () => {
    let failing = false;
    mockTransport(
      platformRoutes({
        [GROUPS]: () =>
          failing
            ? errorResponse(500, "INTERNAL")
            : jsonResponse({
                groups: groupsOf["org-1"].map((group) => ({
                  ...group,
                  organizationId: "org-1",
                  description: null,
                })),
              }),
      }),
    );
    const { store } = renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    addOrganization(1, "org-1");
    await toStep3();
    await addGroup("Academia Norte", "group-a");

    failing = true;
    await forgetGroups(store.getSnapshot().client);
    await screen.findByText("No fue posible cargar los grupos.");
    press("Siguiente");
    expect(screen.getByRole("heading", { name: /Paso 3 de 4/ })).toBeTruthy();
    expect(screen.getAllByText(NOT_LOADED).length).toBeGreaterThan(0);

    failing = false;
    press("Reintentar grupos");
    await waitFor(() => expect(screen.queryByText(NOT_LOADED)).toBeNull());
    await toSummary();
  });

  it("does not create the user while a chosen group's list is not loaded", async () => {
    let failing = false;
    const transport = mockTransport(
      platformRoutes({
        [GROUPS]: () =>
          failing
            ? errorResponse(500, "INTERNAL")
            : jsonResponse({
                groups: groupsOf["org-1"].map((group) => ({
                  ...group,
                  organizationId: "org-1",
                  description: null,
                })),
              }),
        "POST /api/v1/admin/users": () => created(),
      }),
    );
    const { store } = renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    addOrganization(1, "org-1");
    await toStep3();
    await addGroup("Academia Norte", "group-a");
    await toSummary();

    failing = true;
    await forgetGroups(store.getSnapshot().client);
    press("Crear usuario");
    await heading(/Paso 3 de 4/);
    expect(transport.calls("POST /api/v1/admin/users")).toHaveLength(0);
  });

  it("lets an organization without group drafts pass even if its groups never load", async () => {
    mockTransport(
      platformRoutes({ [GROUPS]: () => errorResponse(500, "INTERNAL") }),
    );
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    addOrganization(1, "org-1");
    await toStep3();
    await screen.findByText("No fue posible cargar los grupos.");
    await toSummary();
  });
});

describe("group cap of one creation (CR-251)", () => {
  // 200 group drafts through the whole wizard cost minutes of jsdom time, so
  // the step is rendered on its own; the count and the flagging of the drafts
  // past the cap are covered in draft.ui.test.ts.
  function renderStep(limitReached: boolean) {
    mockTransport({
      "GET /api/v1/organizations/org-1/groups": () =>
        jsonResponse({
          groups: groupsOf["org-1"].map((group) => ({
            ...group,
            organizationId: "org-1",
            description: null,
          })),
        }),
    });
    renderWithIdentity(
      <GroupsStep
        memberName="Diego Rojas"
        organizations={[emptyOrganization("org-1")]}
        options={[north]}
        fixed={false}
        errors={{}}
        disabled={false}
        limitReached={limitReached}
        collapsedOrganizations={new Set()}
        openGroups={new Set()}
        onToggleOrganization={() => {}}
        onToggleGroup={() => {}}
        onGroupAdded={() => {}}
        onChange={() => {}}
      />,
    );
    return within(groupsOfOrganization("Academia Norte"));
  }

  it("stops offering new groups at the cap and says so", async () => {
    const section = renderStep(true);
    expect(
      await section.findByText(
        "Alcanzaste el máximo de 200 grupos en total para un usuario.",
      ),
    ).toBeTruthy();
    expect(
      section.getByRole("button", { name: "Agregar a un grupo" }),
    ).toHaveProperty("disabled", true);
  });

  it("offers them below the cap", async () => {
    const section = renderStep(false);
    await waitFor(() =>
      expect(
        section.getByRole("button", { name: "Agregar a un grupo" }),
      ).toHaveProperty("disabled", false),
    );
    expect(section.queryByText(/Alcanzaste el máximo/)).toBeNull();
  });
});

describe("choices that vanish after a refresh (CR-232)", () => {
  const STALE_ORGANIZATION =
    "Esta organización ya no está disponible. Elige otra o quítala.";
  const STALE_GROUP =
    "Este grupo ya no existe en la organización. Elige otro o quítalo.";

  it("flags an organization that left the list and blocks advancing until it is fixed", async () => {
    let organizations = [north, south];
    const transport = mockTransport(
      platformRoutes({
        "GET /api/v1/organizations": () =>
          jsonResponse({
            organizations: organizations.map((org) => ({
              ...org,
              slug: org.id,
              description: null,
              enabled: true,
              createdAt: "2026-10-01T00:00:00.000Z",
            })),
          }),
      }),
    );
    const { store } = renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    addOrganization(1, "org-1");
    expect(screen.queryByText(STALE_ORGANIZATION)).toBeNull();

    // Another administrator removed the organization: the list refreshes.
    organizations = [south];
    const reads = transport.calls("GET /api/v1/organizations").length;
    await act(async () => {
      await store.getSnapshot().client.invalidateQueries({
        queryKey: ["identity", "admin-1", "orgs"],
      });
    });
    await waitFor(() =>
      expect(
        transport.calls("GET /api/v1/organizations").length,
      ).toBeGreaterThan(reads),
    );

    // The draft keeps what was filled in, flagged: nothing is dropped silently.
    const stale = await screen.findByText(STALE_ORGANIZATION);
    expect(stale).toBeTruthy();
    const select = within(card(1)).getByLabelText("Organización");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    press("Siguiente");
    expect(screen.getByRole("heading", { name: /Paso 2 de 4/ })).toBeTruthy();

    // Choosing one that exists clears the flag and lets the person go on.
    fireEvent.change(select, { target: { value: "org-2" } });
    expect(screen.queryByText(STALE_ORGANIZATION)).toBeNull();
    await toStep3();
  });

  it("does not send the creation when the organization is gone: it goes back to step 2", async () => {
    let organizations = [north, south];
    const transport = mockTransport(
      platformRoutes({
        "GET /api/v1/organizations": () =>
          jsonResponse({
            organizations: organizations.map((org) => ({
              ...org,
              slug: org.id,
              description: null,
              enabled: true,
              createdAt: "2026-10-01T00:00:00.000Z",
            })),
          }),
        "POST /api/v1/admin/users": () => created(),
      }),
    );
    const { store } = renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    addOrganization(1, "org-1");
    await toStep3();
    await toSummary();

    organizations = [south];
    const reads = transport.calls("GET /api/v1/organizations").length;
    await act(async () => {
      await store.getSnapshot().client.invalidateQueries({
        queryKey: ["identity", "admin-1", "orgs"],
      });
    });
    await waitFor(() =>
      expect(
        transport.calls("GET /api/v1/organizations").length,
      ).toBeGreaterThan(reads),
    );

    press("Crear usuario");
    await heading(/Paso 2 de 4/);
    expect(screen.getByText(STALE_ORGANIZATION)).toBeTruthy();
    expect(transport.calls("POST /api/v1/admin/users")).toHaveLength(0);
  });

  it("flags a group that no longer exists in its organization when the groups are re-read", async () => {
    let groups = groupsOf["org-1"];
    const transport = mockTransport(
      platformRoutes({
        "GET /api/v1/organizations/org-1/groups": () =>
          jsonResponse({
            groups: groups.map((group) => ({
              ...group,
              organizationId: "org-1",
              description: null,
            })),
          }),
        "POST /api/v1/admin/users": () => errorResponse(404, "NOT_FOUND"),
      }),
    );
    renderApp({ route: NEW_USER });
    await fillData();
    await toStep2();
    addOrganization(1, "org-1");
    await toStep3();
    await addGroup("Academia Norte", "group-a");
    await toSummary();

    // The group is deleted while the person reviews the summary; the server
    // answers 404 and the choices are refreshed.
    groups = [groupsOf["org-1"][1]];
    press("Crear usuario");
    await heading(/Paso 2 de 4/);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "ya no existe",
    );
    const reads = transport.calls(
      "GET /api/v1/organizations/org-1/groups",
    ).length;

    await toStep3();
    await waitFor(() =>
      expect(
        transport.calls("GET /api/v1/organizations/org-1/groups").length,
      ).toBeGreaterThan(reads),
    );
    // The group draft is flagged, with its permissions still in place.
    const section = within(groupsOfOrganization("Academia Norte"));
    expect(await section.findByText(STALE_GROUP)).toBeTruthy();
    // The select says so too: the stale choice is not hidden behind the
    // placeholder, and it is marked invalid.
    const select = section.getByLabelText("Grupo") as HTMLSelectElement;
    expect(select.selectedOptions[0]?.text).toBe(
      "Contabilidad (no disponible)",
    );
    expect(select.getAttribute("aria-invalid")).toBe("true");
    press("Siguiente");
    expect(screen.getByRole("heading", { name: /Paso 3 de 4/ })).toBeTruthy();

    // Removing the stale group lets the person continue.
    fireEvent.click(section.getByRole("button", { name: /Quitar grupo/ }));
    await toSummary();
  });
});
