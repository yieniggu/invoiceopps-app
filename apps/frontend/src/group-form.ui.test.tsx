import { cleanup, fireEvent, screen } from "@testing-library/react";
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

const org = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia Norte",
};
const admin = profileFixture({ memberships: [membership(org, "ADMIN")] });
const users = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Ada Lovelace",
    rut: "123456785",
    role: "ADMIN",
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    name: "Carla Soto",
    rut: "190347907",
    role: "USER",
  },
];
const BASE = "/api/v1/organizations/00000000-0000-4000-9000-000000000001";
const NEW_GROUP =
  "/organizations/00000000-0000-4000-9000-000000000001/groups/new";

/** A stateful backend for one create flow: the new group appears once POSTed. */
function backend(overrides: Record<string, () => Response> = {}) {
  const groups: unknown[] = [];
  const created = {
    id: "00000000-0000-4000-a000-000000000110",
    organizationId: "00000000-0000-4000-9000-000000000001",
    name: "Cobranza",
    description: null,
  };
  return mockTransport({
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: admin }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    [`GET ${BASE}/users`]: () => jsonResponse({ users }),
    [`GET ${BASE}/groups`]: () => jsonResponse({ groups }),
    [`GET ${BASE}/groups/00000000-0000-4000-a000-000000000110/memberships`]:
      () => jsonResponse({ memberships: [] }),
    [`POST ${BASE}/groups`]: () => {
      groups.push(created);
      return jsonResponse({ group: created }, 201);
    },
    ...overrides,
  });
}

describe("GroupForm (create)", () => {
  it("asks only for the name and the description: no people and no permissions", async () => {
    const transport = backend();
    renderApp({ route: NEW_GROUP });
    expect(await screen.findByLabelText("Nombre del grupo")).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.getByLabelText("Descripción (opcional)")).toHaveProperty(
      "disabled",
      false,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("group", { name: /Permisos/ })).toBeNull();
    // The organization's people are not even read: they are picked afterwards.
    expect(transport.requests.some(({ path }) => path.endsWith("/users"))).toBe(
      false,
    );
  });

  it("creates the group with the trimmed name and description, then goes on to add its members", async () => {
    const transport = backend();
    renderApp({ route: NEW_GROUP });
    fireEvent.change(await screen.findByLabelText("Nombre del grupo"), {
      target: { value: "  Cobranza " },
    });
    fireEvent.change(screen.getByLabelText("Descripción (opcional)"), {
      target: { value: " Equipo de cobranza " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear grupo" }));
    await screen.findByText("Grupo creado. Agrega a sus miembros.");
    expect(window.location.pathname).toBe(
      "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000110/members/new",
    );
    expect(transport.calls(`POST ${BASE}/groups`)).toHaveLength(1);
    expect(transport.calls(`POST ${BASE}/groups`)[0].body).toEqual({
      name: "Cobranza",
      description: "Equipo de cobranza",
    });
    // The only write is the group itself: members come on the next screen.
    expect(
      transport.requests.filter(({ method }) => method !== "GET"),
    ).toHaveLength(1);
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

  it("stays on the form and keeps the typed values when the group cannot be created", async () => {
    const transport = backend({
      [`POST ${BASE}/groups`]: () => errorResponse(403, "FORBIDDEN"),
    });
    renderApp({ route: NEW_GROUP });
    fireEvent.change(await screen.findByLabelText("Nombre del grupo"), {
      target: { value: "  Cobranza " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear grupo" }));
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
