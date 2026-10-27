import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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

const org = { id: "org-1", name: "Academia Norte" };
const admin = profileFixture({ memberships: [membership(org, "ADMIN")] });
const none = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};
const users = [
  { id: "user-1", name: "Ada Lovelace", rut: "123456785", role: "ADMIN" },
  { id: "user-3", name: "Carla Soto", rut: "190347907", role: "USER" },
  { id: "user-4", name: "Diego Rojas", rut: "111111111", role: "USER" },
];
const BASE = "/api/v1/organizations/org-1";
const NEW_GROUP = "/organizaciones/org-1/grupos/nuevo";

/** A stateful backend for one create flow: the new group appears once POSTed. */
function backend(overrides: Record<string, () => Response> = {}) {
  const groups: unknown[] = [];
  const created = {
    id: "group-n",
    organizationId: "org-1",
    name: "Cobranza",
    description: null,
    permissions: none,
  };
  const transport = mockTransport({
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: admin }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    [`GET ${BASE}/users`]: () => jsonResponse({ users }),
    [`GET ${BASE}/groups`]: () => jsonResponse({ groups }),
    [`GET ${BASE}/groups/group-n/memberships`]: () =>
      jsonResponse({ memberships: [] }),
    [`POST ${BASE}/groups`]: () => {
      groups.push(created);
      return jsonResponse({ group: created }, 201);
    },
    [`PATCH ${BASE}/groups/group-n`]: () => jsonResponse({ group: created }),
    [`POST ${BASE}/groups/group-n/memberships`]: () =>
      jsonResponse({ membership: { userId: "x" } }, 201),
    ...overrides,
  });
  return transport;
}

async function fillAndSubmit({
  permissions = [] as string[],
  members = [] as string[],
} = {}) {
  fireEvent.change(await screen.findByLabelText("Nombre del grupo"), {
    target: { value: "  Cobranza " },
  });
  for (const label of permissions)
    fireEvent.click(screen.getByRole("checkbox", { name: label }));
  for (const name of members) {
    fireEvent.click(
      await screen.findByRole("checkbox", { name: new RegExp(name) }),
    );
  }
  fireEvent.click(screen.getByRole("button", { name: "Crear grupo" }));
}

describe("GroupForm in create mode", () => {
  it("offers name, description, the four permissions and the organization's people", async () => {
    backend();
    renderApp({ route: NEW_GROUP });
    expect(await screen.findByLabelText("Nombre del grupo")).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByLabelText("Descripción (opcional)")).toHaveProperty(
      "disabled",
      false,
    );
    for (const label of [
      "Leer facturas",
      "Crear facturas",
      "Eliminar facturas propias",
      "Eliminar facturas de otros",
    ]) {
      const box = screen.getByRole("checkbox", { name: label });
      expect(box.matches(":disabled")).toBe(false);
      expect((box as HTMLInputElement).checked).toBe(false);
    }
    expect(
      await screen.findByRole("checkbox", { name: /Carla Soto/ }),
    ).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(4 + users.length);
  });

  it("creates the group, then patches permissions, then adds each member, strictly in that order", async () => {
    const transport = backend();
    renderApp({ route: NEW_GROUP });
    await fillAndSubmit({
      permissions: ["Leer facturas", "Crear facturas"],
      members: ["Ada Lovelace", "Diego Rojas"],
    });
    await screen.findByText("Grupo «Cobranza» creado.");
    expect(window.location.pathname).toBe(
      "/organizaciones/org-1/grupos/group-n",
    );

    const writes = transport.requests
      .filter(({ method }) => method !== "GET")
      .map(({ method, path, body }) => [method, path, body]);
    expect(writes).toEqual([
      ["POST", `${BASE}/groups`, { name: "Cobranza" }],
      [
        "PATCH",
        `${BASE}/groups/group-n`,
        {
          permissions: {
            readInvoices: true,
            createInvoices: true,
            deleteOwnInvoices: false,
            deleteOthersInvoices: false,
          },
        },
      ],
      ["POST", `${BASE}/groups/group-n/memberships`, { userId: "user-1" }],
      ["POST", `${BASE}/groups/group-n/memberships`, { userId: "user-4" }],
    ]);
    // Nothing failed: no retry banner.
    expect(screen.queryByText("Configuración inicial incompleta")).toBeNull();
  });

  it("skips the permissions step when every flag is off", async () => {
    const transport = backend();
    renderApp({ route: NEW_GROUP });
    await fillAndSubmit({ members: ["Carla Soto"] });
    await screen.findByText("Grupo «Cobranza» creado.");
    expect(
      transport.requests
        .filter(({ method }) => method !== "GET")
        .map(({ method }) => method),
    ).toEqual(["POST", "POST"]);
  });

  it("validates the name before sending anything", async () => {
    const transport = backend();
    renderApp({ route: NEW_GROUP });
    const name = await screen.findByLabelText("Nombre del grupo");
    fireEvent.click(screen.getByRole("button", { name: "Crear grupo" }));
    expect(screen.getByText("Ingresa el nombre del grupo.")).toBeTruthy();
    expect(document.activeElement).toBe(name);
    expect(transport.requests.filter(({ method }) => method !== "GET")).toEqual(
      [],
    );
  });

  it("stays on the form without further steps when the group itself cannot be created", async () => {
    const transport = backend({
      [`POST ${BASE}/groups`]: () => errorResponse(403, "FORBIDDEN"),
    });
    renderApp({ route: NEW_GROUP });
    await fillAndSubmit({
      permissions: ["Leer facturas"],
      members: ["Ada Lovelace"],
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No tienes permiso para realizar esta acción.",
    );
    expect(window.location.pathname).toBe(NEW_GROUP);
    expect(
      (screen.getByLabelText("Nombre del grupo") as HTMLInputElement).value,
    ).toBe("  Cobranza ");
    expect(
      transport.requests.filter(({ method }) => method !== "GET"),
    ).toHaveLength(1);
  });

  it("opens the existing group and names the members that failed, then retries only those", async () => {
    let carlaFails = true;
    const transport = backend();
    // Ada succeeds; Carla fails once, then succeeds on the retry.
    transport.routes[`POST ${BASE}/groups/group-n/memberships`] = (request) => {
      const { userId } = request.body as { userId: string };
      if (userId === "user-3" && carlaFails)
        return errorResponse(409, "MEMBERSHIP_CONFLICT");
      return jsonResponse({ membership: { userId } }, 201);
    };
    renderApp({ route: NEW_GROUP });
    await fillAndSubmit({
      members: ["Ada Lovelace", "Carla Soto", "Diego Rojas"],
    });

    // The group exists, so the person lands on its detail with what is missing.
    expect(
      await screen.findByText("Configuración inicial incompleta"),
    ).toBeTruthy();
    expect(window.location.pathname).toBe(
      "/organizaciones/org-1/grupos/group-n",
    );
    expect(
      screen.getByText(
        "Grupo «Cobranza» creado, pero no se pudo completar su configuración inicial.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Agregar a Carla Soto al grupo.")).toBeTruthy();
    expect(screen.queryByText("Agregar a Ada Lovelace al grupo.")).toBeNull();
    expect(screen.queryByText("Agregar a Diego Rojas al grupo.")).toBeNull();
    // Diego (after the failure) was still attempted: steps settle on their own.
    expect(
      transport
        .calls(`POST ${BASE}/groups/group-n/memberships`)
        .map(({ body }) => (body as { userId: string }).userId),
    ).toEqual(["user-1", "user-3", "user-4"]);

    carlaFails = false;
    fireEvent.click(
      screen.getByRole("button", { name: "Reintentar pasos pendientes" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Configuración inicial incompleta")).toBeNull(),
    );
    const posts = transport
      .calls(`POST ${BASE}/groups/group-n/memberships`)
      .map(({ body }) => (body as { userId: string }).userId);
    expect(posts).toEqual(["user-1", "user-3", "user-4", "user-3"]);
    // The group itself was created exactly once.
    expect(transport.calls(`POST ${BASE}/groups`)).toHaveLength(1);
  });

  it("keeps the chosen permissions to retry when saving them failed, and still adds the members", async () => {
    let patchFails = true;
    const transport = backend();
    transport.routes[`PATCH ${BASE}/groups/group-n`] = () =>
      patchFails ? errorResponse(500, "INTERNAL") : jsonResponse({ group: {} });
    renderApp({ route: NEW_GROUP });
    await fillAndSubmit({
      permissions: ["Eliminar facturas de otros"],
      members: ["Ada Lovelace"],
    });
    expect(
      await screen.findByText("Configuración inicial incompleta"),
    ).toBeTruthy();
    expect(screen.getByText("Guardar los permisos elegidos.")).toBeTruthy();
    expect(screen.queryByText(/Agregar a Ada Lovelace/)).toBeNull();
    expect(
      transport.calls(`POST ${BASE}/groups/group-n/memberships`),
    ).toHaveLength(1);

    patchFails = false;
    fireEvent.click(
      screen.getByRole("button", { name: "Reintentar pasos pendientes" }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Configuración inicial incompleta")).toBeNull(),
    );
    const patches = transport.calls(`PATCH ${BASE}/groups/group-n`);
    expect(patches).toHaveLength(2);
    expect(patches[1].body).toEqual({
      permissions: {
        readInvoices: false,
        createInvoices: false,
        deleteOwnInvoices: false,
        deleteOthersInvoices: true,
      },
    });
    // The member added in the first pass is not added again.
    expect(
      transport.calls(`POST ${BASE}/groups/group-n/memberships`),
    ).toHaveLength(1);
  });

  it("tells a regular member that only administrators create groups", async () => {
    mockTransport({
      "GET /api/v1/auth/profile": () =>
        jsonResponse({
          profile: profileFixture({ memberships: [membership(org, "USER")] }),
        }),
      "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    });
    renderApp({ route: NEW_GROUP });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "No tienes permiso para crear grupos",
    );
    expect(screen.queryByLabelText("Nombre del grupo")).toBeNull();
  });
});
