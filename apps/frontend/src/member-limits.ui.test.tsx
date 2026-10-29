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
  groupMembershipsPage,
  jsonResponse,
  membership,
  mockTransport,
  pagedList,
  NO_PERMISSIONS,
  profileFixture,
  usersPage,
} from "./test/transport";
import { uuid } from "./test/ids";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// CR-240: the server takes 1 to 200 people per bulk operation; every screen
// that builds such an operation says so before sending, and the URL of a bulk
// screen cannot make the app process an unbounded list.

const north = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia Norte",
};
const adminProfile = profileFixture({
  memberships: [membership(north, "ADMIN")],
});

const person = (index: number) => ({
  id: uuid(index),
  name: `Persona ${String(index).padStart(3, "0")}`,
  rut: `${10_000_000 + index}9`,
});
const people = (count: number) =>
  Array.from({ length: count }, (_unused, index) => person(index));

const orgMember = (index: number) => ({
  userId: person(index).id,
  organizationId: "00000000-0000-4000-9000-000000000001",
  role: "USER",
  permissions: NO_PERMISSIONS,
  groups: [],
  user: person(index),
});
const groupMember = (index: number) => ({
  userId: person(index).id,
  groupId: "00000000-0000-4000-a000-000000000097",
  organizationId: "00000000-0000-4000-9000-000000000001",
  permissions: NO_PERMISSIONS,
  user: person(index),
});

const group = {
  id: "00000000-0000-4000-a000-000000000097",
  organizationId: "00000000-0000-4000-9000-000000000001",
  name: "Contabilidad",
  description: null,
};

function routes(count: number, inGroup = count) {
  return {
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: adminProfile }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
      () =>
        jsonResponse({
          memberships: people(count).map((_p, i) => orgMember(i)),
        }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
      () =>
        jsonResponse(
          usersPage(people(count).map((user) => ({ ...user, role: "USER" }))),
        ),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups":
      () => jsonResponse({ groups: [group] }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships":
      () =>
        jsonResponse(
          groupMembershipsPage(people(inGroup).map((_p, i) => groupMember(i))),
        ),
  };
}

const TOO_MANY = "Selecciona hasta 200 personas por operación.";

// Role queries compute the accessible name of every control (hundreds of
// checkboxes and buttons here) and cost about a second each on an idle machine
// and far more under load; exact-label and text queries find the same elements
// in milliseconds. A regular-expression label query scans every label of the
// page (1.3 s for the 201 people of the add form), so the heavy screens are
// queried by text.
const byText = (text: string) =>
  screen.getByText(text).closest("button") as HTMLButtonElement;

describe("members lists", () => {
  it.each([
    [
      "organization",
      "/organizations/00000000-0000-4000-9000-000000000001/members",
    ],
    [
      "group",
      "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members",
    ],
  ])(
    "blocks the bulk edit above 200 people on the %s screen",
    async (_level, route) => {
      mockTransport(routes(201));
      renderApp({ route });
      const all = await screen.findByLabelText(
        "Seleccionar todos en esta página",
      );
      const bulk = byText("Editar permisos en bloque");

      fireEvent.click(all);
      expect(screen.getByText(TOO_MANY)).toBeTruthy();
      expect(bulk.disabled).toBe(true);

      // One person less brings it back to the limit.
      fireEvent.click(screen.getByLabelText("Seleccionar a Persona 200"));
      expect(
        screen.getByText("200 personas seleccionadas en esta página."),
      ).toBeTruthy();
      expect(bulk.disabled).toBe(false);
    },
  );

  it("opens the bulk screen with exactly 200 ids", async () => {
    mockTransport(routes(200));
    renderApp({
      route: "/organizations/00000000-0000-4000-9000-000000000001/members",
    });
    fireEvent.click(
      await screen.findByLabelText("Seleccionar todos en esta página"),
    );
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
  const NEW =
    "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members/new";

  it("blocks the batch above 200 people, says so, and sends 200 once one is unselected", async () => {
    const POST =
      "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships/bulk";
    const MEMBERS =
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships";
    let added = false;
    const transport = mockTransport({
      ...routes(201, 0),
      // The people page like the server (20 per page: 11 pages for 201).
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/users":
        pagedList(
          "users",
          people(201).map((user) => ({ ...user, role: "USER" })),
          ({ id }) => id,
        ),
      // Once the batch is in, the group lists its new members. Two stand in
      // for the 200: the destination screen's cost is rows, and what this
      // test proves (the limit, the 200 sent, the navigation and the notice)
      // does not depend on how many of them it draws.
      [MEMBERS]: () =>
        jsonResponse(
          groupMembershipsPage(
            people(added ? 2 : 0).map((_p, i) => groupMember(i)),
          ),
        ),
      [POST]: () => {
        added = true;
        return jsonResponse({ memberships: [] }, 201);
      },
    });
    renderApp({ route: NEW });
    // The selection spans pages: "select all" ticks the page on screen, and
    // the earlier pages stay ticked. 11 pages of 20 hold the 201 people.
    // Raw DOM queries on the pick list and its "select all": a text or label
    // query scans every node of the page, and the 200 cards drawn below make
    // that scan the dominant cost of this test.
    const pickList = () =>
      document.querySelector(".checkbox-list") as HTMLElement;
    for (let page = 1; page <= 11; page += 1) {
      const first = `Persona ${String((page - 1) * 20).padStart(3, "0")}`;
      await waitFor(() => expect(pickList().textContent).toContain(first));
      fireEvent.click(
        document.querySelector(
          "fieldset label.check-row input",
        ) as HTMLInputElement,
      );
      if (page < 11) fireEvent.click(byText("Siguiente"));
    }
    const submit = byText("Agregar 201 personas al grupo");
    expect(submit.disabled).toBe(true);
    expect(
      screen.getByText("Puedes agregar hasta 200 personas por operación."),
    ).toBeTruthy();
    fireEvent.submit(submit.closest("form") as HTMLFormElement);
    expect(transport.calls(POST)).toHaveLength(0);

    // Found by its text inside the pick list: a label query over ~400
    // controls took 1.3 s here.
    fireEvent.click(
      within(pickList())
        .getByText("Persona 200")
        .closest("label")!
        .querySelector("input") as HTMLInputElement,
    );
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
      "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members",
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
      "/organizations/00000000-0000-4000-9000-000000000001/members/permissions",
      "PUT /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/permissions",
    ],
    [
      "group",
      "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members/permissions",
      "PUT /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships/permissions",
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
      route: `/organizations/00000000-0000-4000-9000-000000000001/members/permissions?userIds=${ids(300)}`,
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
    const PUT =
      "PUT /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships/permissions";
    const transport = mockTransport({
      ...routes(200),
      [PUT]: () => jsonResponse({ memberships: [] }),
    });
    renderApp({
      route: `/organizations/00000000-0000-4000-9000-000000000001/members/permissions?userIds=${ids(200)}`,
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
