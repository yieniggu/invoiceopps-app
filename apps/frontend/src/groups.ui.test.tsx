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
  permissions: { ...none },
};
const sales = {
  id: "group-b",
  organizationId: "org-1",
  name: "Ventas",
  description: "Equipo comercial",
  permissions: { ...none, readInvoices: true },
};
const southGroup = {
  id: "group-c",
  organizationId: "org-2",
  name: "Operaciones",
  description: null,
  permissions: { ...none },
};
const north = { id: "org-1", name: "Academia Norte" };
const south = { id: "org-2", name: "Instituto Sur" };
const admin = profileFixture({
  memberships: [membership(north, "ADMIN"), membership(south, "ADMIN")],
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

const DETAIL = "/organizaciones/org-1/grupos";

describe("group list and creation (AC-11)", () => {
  it("creates a group with name and optional description only", async () => {
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
    renderApp({ route: `${DETAIL}/nuevo` });
    fireEvent.change(await screen.findByLabelText("Nombre del grupo"), {
      target: { value: "Cobranza" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear grupo" }));
    // Success lands on the new group's detail with a status message.
    await screen.findByText("Grupo «Cobranza» creado.");
    expect(
      screen.getByRole("heading", { level: 1, name: "Cobranza" }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(`${DETAIL}/group-n`);
    expect(
      transport.calls("POST /api/v1/organizations/org-1/groups")[0].body,
    ).toEqual({
      name: "Cobranza",
    });
    // No flag was set and no member chosen: no further write is made.
    expect(
      transport.requests.filter(
        ({ method, path }) =>
          method !== "GET" && path !== "/api/v1/organizations/org-1/groups",
      ),
    ).toEqual([]);
    // The list is read after the write, so the new group is what the detail shows.
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

  it("shows only own groups and no administration controls to a regular member", async () => {
    const member = profileFixture({ memberships: [membership(north, "USER")] });
    mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: member }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations/org-1/groups": () =>
        jsonResponse({ groups: [sales] }),
    });
    renderApp({ route: "/grupos" });
    expect(await screen.findByText("Ventas")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Crear grupo/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Guardar permisos/ }),
    ).toBeNull();
    // The human summary replaces the raw flags in the list.
    expect(screen.getByText("Puede leer facturas")).toBeTruthy();
  });

  it("lists my groups per organization with a human summary of permissions", async () => {
    mockTransport(baseRoutes());
    renderApp({ route: "/grupos" });
    expect(await screen.findByText("Contabilidad")).toBeTruthy();
    // Contabilidad (org 1) and Operaciones (org 2) grant nothing.
    expect(await screen.findByText("Operaciones")).toBeTruthy();
    expect(screen.getAllByText("Sin permisos sobre facturas")).toHaveLength(2);
    expect(screen.getByText("Puede leer facturas")).toBeTruthy();
    // ADMIN of both organizations: one create action per section.
    expect(
      screen.getByRole("link", { name: "Crear grupo en Academia Norte" }),
    ).toHaveProperty(
      "href",
      expect.stringContaining("/organizaciones/org-1/grupos/nuevo"),
    );
    expect(
      screen.getByRole("link", { name: "Crear grupo en Instituto Sur" }),
    ).toBeTruthy();
  });
});

describe("group permissions editor (AC-11)", () => {
  it("offers four independent labelled checkboxes, unchecked by default", async () => {
    mockTransport(baseRoutes());
    renderApp({ route: `${DETAIL}/group-a` });
    const editor = await screen.findByRole("group", {
      name: "Permisos sobre facturas",
    });
    for (const label of [
      "Leer facturas",
      "Crear facturas",
      "Eliminar facturas propias",
      "Eliminar facturas de otros",
    ]) {
      const box = within(editor).getByRole("checkbox", { name: label });
      expect((box as HTMLInputElement).checked).toBe(false);
    }
    // Toggling one flag does not imply any other.
    fireEvent.click(
      within(editor).getByRole("checkbox", {
        name: "Eliminar facturas de otros",
      }),
    );
    expect(
      (
        within(editor).getByRole("checkbox", {
          name: "Eliminar facturas propias",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  it("shows the saved flags of the group it opens", async () => {
    mockTransport(baseRoutes());
    renderApp({ route: `${DETAIL}/group-b` });
    const editor = await screen.findByRole("group", {
      name: "Permisos sobre facturas",
    });
    expect(
      (
        within(editor).getByRole("checkbox", {
          name: "Leer facturas",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("PATCHes all four flags and invalidates only this organization's groups, this group's memberships and the profile", async () => {
    const transport = mockTransport({
      ...baseRoutes(),
      "GET /api/v1/organizations/org-1/groups/group-a/memberships": () =>
        jsonResponse({ memberships: [] }),
      "PATCH /api/v1/organizations/org-1/groups/group-a": () =>
        jsonResponse({
          group: {
            ...accounting,
            permissions: {
              ...none,
              createInvoices: true,
              deleteOwnInvoices: true,
            },
          },
        }),
    });
    renderApp({ route: `${DETAIL}/group-a` });
    await screen.findByRole("heading", { name: "Miembros de Contabilidad" });

    const before = {
      groupsNorth: transport.calls("GET /api/v1/organizations/org-1/groups")
        .length,
      membersA: transport.calls(
        "GET /api/v1/organizations/org-1/groups/group-a/memberships",
      ).length,
      profile: transport.calls("GET /api/v1/auth/profile").length,
    };

    const editor = screen.getByRole("group", {
      name: "Permisos sobre facturas",
    });
    fireEvent.click(
      within(editor).getByRole("checkbox", { name: "Crear facturas" }),
    );
    fireEvent.click(
      within(editor).getByRole("checkbox", {
        name: "Eliminar facturas propias",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar permisos" }));
    await screen.findByText("Permisos guardados.");

    expect(
      transport.calls("PATCH /api/v1/organizations/org-1/groups/group-a")[0]
        .body,
    ).toEqual({
      permissions: {
        readInvoices: false,
        createInvoices: true,
        deleteOwnInvoices: true,
        deleteOthersInvoices: false,
      },
    });
    await waitFor(() =>
      expect(
        transport.calls("GET /api/v1/organizations/org-1/groups"),
      ).toHaveLength(before.groupsNorth + 1),
    );
    await waitFor(() =>
      expect(
        transport.calls(
          "GET /api/v1/organizations/org-1/groups/group-a/memberships",
        ),
      ).toHaveLength(before.membersA + 1),
    );
    await waitFor(() =>
      expect(transport.calls("GET /api/v1/auth/profile")).toHaveLength(
        before.profile + 1,
      ),
    );
    // Untouched: another organization, another group.
    expect(
      transport.calls("GET /api/v1/organizations/org-2/groups"),
    ).toHaveLength(0);
    expect(
      transport.calls(
        "GET /api/v1/organizations/org-1/groups/group-b/memberships",
      ),
    ).toHaveLength(0);
  });

  it("explains a rejected permission change without losing the draft", async () => {
    mockTransport({
      ...baseRoutes(),
      "GET /api/v1/organizations/org-1/groups/group-a/memberships": () =>
        jsonResponse({ memberships: [] }),
      "PATCH /api/v1/organizations/org-1/groups/group-a": () =>
        errorResponse(403, "FORBIDDEN"),
    });
    renderApp({ route: `${DETAIL}/group-a` });
    const editor = await screen.findByRole("group", {
      name: "Permisos sobre facturas",
    });
    fireEvent.click(
      within(editor).getByRole("checkbox", { name: "Leer facturas" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar permisos" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No tienes permiso para realizar esta acción.",
    );
    expect(
      (
        within(editor).getByRole("checkbox", {
          name: "Leer facturas",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });
});

describe("group detail in view mode (AC-11)", () => {
  it("disables name and description for an ADMIN and lets only permissions change", async () => {
    mockTransport({
      ...baseRoutes(),
      "GET /api/v1/organizations/org-1/groups/group-b/memberships": () =>
        jsonResponse({ memberships: [] }),
    });
    renderApp({ route: `${DETAIL}/group-b` });
    const name = (await screen.findByLabelText(
      "Nombre del grupo",
    )) as HTMLInputElement;
    const description = screen.getByLabelText(
      "Descripción",
    ) as HTMLInputElement;
    expect(name.value).toBe("Ventas");
    expect(name.disabled).toBe(true);
    expect(description.value).toBe("Equipo comercial");
    expect(description.disabled).toBe(true);
    expect(
      screen
        .getByRole("checkbox", { name: "Leer facturas" })
        .matches(":disabled"),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "Guardar permisos" }),
    ).toBeTruthy();
  });

  it("shows a regular member the permissions read-only and no member controls", async () => {
    const member = profileFixture({ memberships: [membership(north, "USER")] });
    const transport = mockTransport({
      "GET /api/v1/auth/profile": () => jsonResponse({ profile: member }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
      "GET /api/v1/organizations/org-1/groups": () =>
        jsonResponse({ groups: [sales] }),
    });
    renderApp({ route: `${DETAIL}/group-b` });
    await screen.findByRole("heading", { level: 1, name: "Ventas" });
    expect(
      (screen.getByLabelText("Nombre del grupo") as HTMLInputElement).disabled,
    ).toBe(true);
    // The fieldset disables its four checkboxes.
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
    for (const box of screen.getAllByRole("checkbox"))
      expect(box.matches(":disabled")).toBe(true);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Leer facturas",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Guardar permisos" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Persona a agregar")).toBeNull();
    expect(screen.queryByRole("heading", { name: /Miembros de/ })).toBeNull();
    // A USER never reads the member lists: no extra requests.
    expect(
      transport.requests.filter(({ path }) =>
        /\/(memberships|users)$/.test(path),
      ),
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
});

describe("group membership (AC-11)", () => {
  it("adds an organization member to the group and removes another", async () => {
    let memberships = [
      {
        userId: "user-3",
        groupId: "group-a",
        organizationId: "org-1",
        user: orgUsers[1],
      },
    ];
    const transport = mockTransport({
      ...baseRoutes(),
      "GET /api/v1/organizations/org-1/groups/group-a/memberships": () =>
        jsonResponse({ memberships }),
      "POST /api/v1/organizations/org-1/groups/group-a/memberships": () => {
        memberships = [
          ...memberships,
          {
            userId: "user-1",
            groupId: "group-a",
            organizationId: "org-1",
            user: orgUsers[0],
          },
        ];
        return jsonResponse(
          {
            membership: {
              userId: "user-1",
              groupId: "group-a",
              organizationId: "org-1",
            },
          },
          201,
        );
      },
      "DELETE /api/v1/organizations/org-1/groups/group-a/memberships/user-3":
        () => {
          memberships = memberships.filter(
            (entry) => entry.userId !== "user-3",
          );
          return new Response(null, { status: 204 });
        },
    });
    renderApp({ route: `${DETAIL}/group-a` });
    expect(await screen.findByText("Carla Soto")).toBeTruthy();
    // Only organization members that are not in the group can be picked.
    const picker = screen.getByLabelText(
      "Persona a agregar",
    ) as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.text)).toEqual([
      "Ada Lovelace",
    ]);
    fireEvent.change(picker, { target: { value: "user-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Agregar al grupo" }));
    await screen.findByText("Persona agregada al grupo.");
    expect(
      transport.calls(
        "POST /api/v1/organizations/org-1/groups/group-a/memberships",
      )[0].body,
    ).toEqual({ userId: "user-1" });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Quitar a Carla Soto del grupo",
      }),
    );
    await waitFor(() =>
      expect(
        transport.calls(
          "DELETE /api/v1/organizations/org-1/groups/group-a/memberships/user-3",
        ),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Quitar a Carla Soto del grupo" }),
      ).toBeNull(),
    );
  });

  it("explains ORGANIZATION_MEMBERSHIP_REQUIRED", async () => {
    mockTransport({
      ...baseRoutes(),
      "GET /api/v1/organizations/org-1/groups/group-a/memberships": () =>
        jsonResponse({ memberships: [] }),
      "POST /api/v1/organizations/org-1/groups/group-a/memberships": () =>
        errorResponse(409, "ORGANIZATION_MEMBERSHIP_REQUIRED"),
    });
    renderApp({ route: `${DETAIL}/group-a` });
    await screen.findByRole("option", { name: "Ada Lovelace" });
    fireEvent.click(screen.getByRole("button", { name: "Agregar al grupo" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "La persona debe pertenecer a la organización antes de asignarla a un grupo.",
    );
  });
});
