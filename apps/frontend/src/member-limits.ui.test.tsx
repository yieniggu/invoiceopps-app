import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "./test/renderApp";
import {
  NO_PERMISSIONS,
  jsonResponse,
  membership,
  mockTransport,
  profileFixture,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// CR-240: the server takes 1 to 200 people per bulk operation; every screen
// that builds such an operation says so before sending, and the URL of a bulk
// screen cannot make the app process an unbounded list.

const north = { id: "org-1", name: "Academia Norte" };
const adminProfile = profileFixture({
  memberships: [membership(north, "ADMIN")],
});

const person = (index: number) => ({
  id: `user-${index}`,
  name: `Persona ${String(index).padStart(3, "0")}`,
  rut: `${10_000_000 + index}9`,
});
const people = (count: number) =>
  Array.from({ length: count }, (_unused, index) => person(index));

const orgMember = (index: number) => ({
  userId: person(index).id,
  organizationId: "org-1",
  role: "USER",
  permissions: NO_PERMISSIONS,
  groups: [],
  user: person(index),
});
const groupMember = (index: number) => ({
  userId: person(index).id,
  groupId: "group-a",
  organizationId: "org-1",
  permissions: NO_PERMISSIONS,
  user: person(index),
});

const group = {
  id: "group-a",
  organizationId: "org-1",
  name: "Contabilidad",
  description: null,
};

function routes(count: number, inGroup = count) {
  return {
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: adminProfile }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations/org-1/memberships": () =>
      jsonResponse({ memberships: people(count).map((_p, i) => orgMember(i)) }),
    "GET /api/v1/organizations/org-1/users": () =>
      jsonResponse({
        users: people(count).map((user) => ({ ...user, role: "USER" })),
      }),
    "GET /api/v1/organizations/org-1/groups": () =>
      jsonResponse({ groups: [group] }),
    "GET /api/v1/organizations/org-1/groups/group-a/memberships": () =>
      jsonResponse({
        memberships: people(inGroup).map((_p, i) => groupMember(i)),
      }),
  };
}

const TOO_MANY = "Selecciona hasta 200 personas por operación.";

// Role queries compute the accessible name of every control (hundreds of
// checkboxes and buttons here) and cost about a second each on an idle machine
// and far more under load; label and text queries find the same elements in
// milliseconds, so the heavy screens are queried that way.
const byText = (text: string) =>
  screen.getByText(text).closest("button") as HTMLButtonElement;

describe("members lists", () => {
  it.each([
    ["organization", "/organizations/org-1/members"],
    ["group", "/organizations/org-1/groups/group-a/members"],
  ])(
    "blocks the bulk edit above 200 people on the %s screen",
    async (_level, route) => {
      mockTransport(routes(201));
      renderApp({ route });
      const all = await screen.findByLabelText("Seleccionar todos");
      const bulk = byText("Editar permisos en bloque");

      fireEvent.click(all);
      expect(screen.getByText(TOO_MANY)).toBeTruthy();
      expect(bulk.disabled).toBe(true);

      // One person less brings it back to the limit.
      fireEvent.click(screen.getByLabelText("Seleccionar a Persona 200"));
      expect(screen.getByText("200 personas seleccionadas.")).toBeTruthy();
      expect(bulk.disabled).toBe(false);
    },
  );

  it("opens the bulk screen with exactly 200 ids", async () => {
    mockTransport(routes(200));
    renderApp({ route: "/organizations/org-1/members" });
    fireEvent.click(await screen.findByLabelText("Seleccionar todos"));
    fireEvent.click(byText("Editar permisos en bloque"));
    await screen.findByText(
      "Define los permisos sobre facturas en la organización y aplícalos de una vez a las personas seleccionadas. Se reemplazan los cuatro permisos de cada una.",
    );
    expect(
      new URLSearchParams(window.location.search).get("userIds")?.split(","),
    ).toHaveLength(200);
  });
});

describe("add members to a group", () => {
  const NEW = "/organizations/org-1/groups/group-a/members/new";

  it("blocks the batch above 200 people, says so, and sends 200 once one is unselected", async () => {
    const POST =
      "POST /api/v1/organizations/org-1/groups/group-a/memberships/bulk";
    const MEMBERS =
      "GET /api/v1/organizations/org-1/groups/group-a/memberships";
    let added = false;
    const transport = mockTransport({
      ...routes(201, 0),
      // Once the batch is in, the group lists its new members. Two stand in
      // for the 200: the destination screen's cost is rows, and what this
      // test proves (the limit, the 200 sent, the navigation and the notice)
      // does not depend on how many of them it draws.
      [MEMBERS]: () =>
        jsonResponse({
          memberships: people(added ? 2 : 0).map((_p, i) => groupMember(i)),
        }),
      [POST]: () => {
        added = true;
        return jsonResponse({ memberships: [] }, 201);
      },
    });
    renderApp({ route: NEW });
    fireEvent.click(await screen.findByLabelText("Seleccionar todos"));
    const submit = byText("Agregar 201 personas al grupo");
    expect(submit.disabled).toBe(true);
    expect(
      screen.getByText("Puedes agregar hasta 200 personas por operación."),
    ).toBeTruthy();
    fireEvent.submit(submit.closest("form") as HTMLFormElement);
    expect(transport.calls(POST)).toHaveLength(0);

    fireEvent.click(screen.getByLabelText(/^Persona 200 \(/));
    const ok = byText("Agregar 200 personas al grupo");
    expect(ok.disabled).toBe(false);
    expect(
      screen.queryByText("Puedes agregar hasta 200 personas por operación."),
    ).toBeNull();
    fireEvent.click(ok);

    // The outcome: the 200 were sent, and the person lands on the group's
    // member list with the notice.
    await screen.findByText("200 personas agregadas al grupo.");
    expect(window.location.pathname).toBe(
      "/organizations/org-1/groups/group-a/members",
    );
    expect(transport.calls(POST)).toHaveLength(1);
    expect(
      (transport.calls(POST)[0]?.body as { members: unknown[] }).members,
    ).toHaveLength(200);
  });
});

describe("bulk permission screens read at most 201 ids from the URL", () => {
  const ids = (count: number) =>
    people(count)
      .map(({ id }) => id)
      .join(",");

  it.each([
    [
      "organization",
      "/organizations/org-1/members/permissions",
      "PUT /api/v1/organizations/org-1/memberships/permissions",
    ],
    [
      "group",
      "/organizations/org-1/groups/group-a/members/permissions",
      "PUT /api/v1/organizations/org-1/groups/group-a/memberships/permissions",
    ],
  ])(
    "%s: 201 ids trip the guard and nothing is sent",
    async (_level, route, put) => {
      const transport = mockTransport({
        ...routes(201),
        [put]: () => jsonResponse({ memberships: [] }),
      });
      renderApp({ route: `${route}?userIds=${ids(201)}` });
      const apply = (await screen.findByText("Aplicar a 201 miembros")).closest(
        "button",
      ) as HTMLButtonElement;
      expect(apply.disabled).toBe(true);
      expect(
        screen.getByText("Puedes editar hasta 200 personas por operación."),
      ).toBeTruthy();
      fireEvent.submit(apply.closest("form") as HTMLFormElement);
      expect(transport.calls(put)).toHaveLength(0);
    },
  );

  it("drops the ids beyond the 201st instead of processing them", async () => {
    mockTransport(routes(300));
    renderApp({
      route: `/organizations/org-1/members/permissions?userIds=${ids(300)}`,
    });
    // 300 are requested, 201 are read: the guard counts 201, not 300.
    expect(
      (
        (await screen.findByText("Aplicar a 201 miembros")).closest(
          "button",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("applies exactly 200 ids", async () => {
    const PUT = "PUT /api/v1/organizations/org-1/memberships/permissions";
    const transport = mockTransport({
      ...routes(200),
      [PUT]: () => jsonResponse({ memberships: [] }),
    });
    renderApp({
      route: `/organizations/org-1/members/permissions?userIds=${ids(200)}`,
    });
    const apply = (await screen.findByText("Aplicar a 200 miembros")).closest(
      "button",
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    fireEvent.click(byText("Leer facturas"));
    fireEvent.click(apply);
    await waitFor(() => expect(transport.calls(PUT)).toHaveLength(1));
    expect(
      (transport.calls(PUT)[0]?.body as { userIds: string[] }).userIds,
    ).toHaveLength(200);
  });
});
