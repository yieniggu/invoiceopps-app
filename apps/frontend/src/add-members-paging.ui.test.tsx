import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "./test/renderApp";
import {
  errorResponse,
  jsonResponse,
  membership,
  mockTransport,
  pagedList,
  profileFixture,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const none = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};
const north = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia Norte",
};
const accounting = {
  id: "00000000-0000-4000-a000-000000000097",
  organizationId: "00000000-0000-4000-9000-000000000001",
  name: "Contabilidad",
  description: null,
};
const admin = profileFixture({ memberships: [membership(north, "ADMIN")] });

// 250 people sorted by name: far more than the 100 of one request.
const PEOPLE = Array.from({ length: 250 }, (_unused, index) => ({
  id: uuid(index + 1),
  name: `Persona ${String(index + 1).padStart(3, "0")}`,
  rut: `${10_000_001 + index}5`,
  role: "USER" as const,
}));
const personByName = (n: number) =>
  PEOPLE.find(({ name }) => name === `Persona ${String(n).padStart(3, "0")}`)!;

// Same rule as the server: a fragment of the name (any case) or of the RUT
// (typed with or without dots and hyphen).
const matches = (person: (typeof PEOPLE)[number], text: string) =>
  person.name.toLowerCase().includes(text.toLowerCase()) ||
  person.rut.includes(text.replace(/[.\-\s]/g, "").toUpperCase());

const USERS =
  "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/users";
const MEMBERS =
  "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships";
const BULK_POST =
  "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships/bulk";
const NEW_MEMBERS =
  "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members/new";

function routes(inGroup: number[] = []) {
  const members = inGroup.map((n) => ({
    userId: uuid(n),
    groupId: "00000000-0000-4000-a000-000000000097",
    organizationId: "00000000-0000-4000-9000-000000000001",
    permissions: none,
    user: PEOPLE[n - 1],
  }));
  return {
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: admin }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups":
      () => jsonResponse({ groups: [accounting] }),
    [USERS]: pagedList("users", PEOPLE, ({ id }) => id, { matches }),
    [MEMBERS]: pagedList("memberships", members, ({ userId }) => userId),
  };
}

const idsOf = (search: string) =>
  (new URLSearchParams(search).get("userIds") ?? "").split(",").filter(Boolean);

describe("adding members to a group scales past one request (CR-298/CR-299)", () => {
  it("reads one page of 20 people and asks the group only about them", async () => {
    const transport = mockTransport(routes([3, 4]));
    renderApp({ route: NEW_MEMBERS });
    await screen.findByRole("checkbox", { name: /Persona 001/ });

    const userCalls = transport.calls(USERS);
    expect(userCalls).toHaveLength(1);
    const first = new URLSearchParams(userCalls[0]!.search);
    expect(first.get("page")).toBe("1");
    expect(first.get("pageSize")).toBe("20");
    // The group is asked once, by exactly the 20 ids on screen.
    await waitFor(() => expect(transport.calls(MEMBERS)).toHaveLength(1));
    const asked = idsOf(transport.calls(MEMBERS)[0]!.search);
    expect(asked).toHaveLength(20);
    expect([...asked].sort()).toEqual(
      PEOPLE.slice(0, 20)
        .map(({ id }) => id)
        .sort(),
    );
    // Members of the group are not offered; the rest of the page is.
    expect(screen.queryByRole("checkbox", { name: /Persona 003/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Persona 004/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Persona 005/ })).toBeTruthy();
    expect(screen.getByText("Página 1 de 13")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByRole("checkbox", { name: /Persona 021/ });
    expect(screen.getByText("Página 2 de 13")).toBeTruthy();
    expect(window.location.search).toBe("?page=2");
    await waitFor(() => expect(transport.calls(MEMBERS)).toHaveLength(2));
    expect(idsOf(transport.calls(MEMBERS)[1]!.search)).toHaveLength(20);

    // Never a walk of the organization, never one request per page of people.
    const sizes = transport
      .calls(USERS)
      .map(({ search }) => new URLSearchParams(search).get("pageSize"));
    expect(sizes).toEqual(["20", "20"]);
    for (const { search } of transport.calls(MEMBERS))
      expect(idsOf(search).length).toBeLessThanOrEqual(20);
  });

  it("searches by name and by RUT on the server and keeps the term in the URL", async () => {
    const transport = mockTransport(routes());
    renderApp({ route: NEW_MEMBERS });
    await screen.findByRole("checkbox", { name: /Persona 001/ });

    const box = screen.getByLabelText("Buscar por nombre o RUT");
    fireEvent.change(box, { target: { value: "persona 2" } });
    // Nothing is sent until the search is submitted.
    expect(transport.calls(USERS)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await screen.findByRole("checkbox", { name: /Persona 200/ });
    expect(window.location.search).toBe("?search=persona+2");
    const searched = new URLSearchParams(transport.calls(USERS).at(-1)!.search);
    expect(searched.get("search")).toBe("persona 2");
    expect(searched.get("page")).toBe("1");
    expect(screen.queryByRole("checkbox", { name: /Persona 001/ })).toBeNull();

    // A RUT typed with dots and hyphen.
    const rut = personByName(7).rut;
    const formatted = `${rut.slice(0, 2)}.${rut.slice(2, 5)}.${rut.slice(5, -1)}-${rut.slice(-1)}`;
    fireEvent.change(screen.getByLabelText("Buscar por nombre o RUT"), {
      target: { value: formatted },
    });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await screen.findByRole("checkbox", { name: /Persona 007/ });
    expect(screen.queryByRole("checkbox", { name: /Persona 200/ })).toBeNull();

    fireEvent.change(screen.getByLabelText("Buscar por nombre o RUT"), {
      target: { value: "zzzz" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    expect(
      await screen.findByText("Ninguna persona coincide con la búsqueda."),
    ).toBeTruthy();
  });

  it("keeps a term typed while the URL changes under it, and shows the URL term on Back when the box is clean (CR-311)", async () => {
    mockTransport(routes());
    renderApp({ route: NEW_MEMBERS });
    await screen.findByRole("checkbox", { name: /Persona 001/ });
    const box = () =>
      screen.getByLabelText("Buscar por nombre o RUT") as HTMLInputElement;

    fireEvent.change(box(), { target: { value: "persona 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await screen.findByRole("checkbox", { name: /Persona 200/ });
    expect(box().value).toBe("persona 2");

    // An unsubmitted edit survives a navigation that changes the URL term.
    fireEvent.change(box(), { target: { value: "zzzz" } });
    await act(async () => window.history.back());
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(box().value).toBe("zzzz");

    // Clean box: Forward shows what the URL says.
    fireEvent.change(box(), { target: { value: "" } });
    await act(async () => window.history.forward());
    await waitFor(() =>
      expect(window.location.search).toBe("?search=persona+2"),
    );
    await waitFor(() => expect(box().value).toBe("persona 2"));
  });

  it("keeps the people chosen on other pages and adds them all in one request", async () => {
    const transport = mockTransport({
      ...routes(),
      [BULK_POST]: () => jsonResponse({ memberships: [] }, 201),
    });
    renderApp({ route: NEW_MEMBERS });
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Persona 002/ }),
    );
    expect(screen.getByText("1 persona seleccionada.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Persona 021/ }),
    );
    expect(screen.getByText("2 personas seleccionadas.")).toBeTruthy();
    // The person of page 1 still has a card, though the page changed.
    expect(screen.getByRole("region", { name: "Persona 002" })).toBeTruthy();

    // "Select all" applies to the page on screen only.
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Seleccionar todos en esta página",
      }),
    );
    expect(screen.getByText("21 personas seleccionadas.")).toBeTruthy();

    // Back on page 1 the earlier choice is still ticked.
    fireEvent.click(screen.getByRole("button", { name: "Anterior" }));
    const again = await screen.findByRole("checkbox", { name: /Persona 002/ });
    expect((again as HTMLInputElement).checked).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "Agregar 21 personas al grupo" }),
    );
    await waitFor(() => expect(transport.calls(BULK_POST)).toHaveLength(1));
    const sent = transport.calls(BULK_POST)[0]!.body as {
      members: Array<{ userId: string }>;
    };
    expect(sent.members).toHaveLength(21);
    expect(sent.members.map(({ userId }) => userId)).toContain(uuid(2));
    expect(sent.members.map(({ userId }) => userId)).toContain(uuid(21));
  });

  it("drops a chosen person who joined the group meanwhile and names them after a rejected batch", async () => {
    let inGroup: number[] = [];
    const base = routes();
    const transport = mockTransport({
      ...base,
      [MEMBERS]: (request) => routes(inGroup)[MEMBERS](request),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
        pagedList(
          "memberships",
          PEOPLE.map((user) => ({ userId: user.id, user })),
          ({ userId }) => userId,
        ),
      [BULK_POST]: () => {
        inGroup = [2];
        return errorResponse(409, "MEMBERSHIP_CONFLICT");
      },
    });
    renderApp({ route: NEW_MEMBERS });
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Persona 002/ }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Persona 005/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Agregar 2 personas al grupo" }),
    );
    await waitFor(() => expect(transport.calls(BULK_POST)).toHaveLength(1));
    const alert = await screen.findByText(/Persona 002 ya no se puede agregar/);
    expect(alert).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /Persona 002/ })).toBeNull();
    expect(screen.getByText("1 persona seleccionada.")).toBeTruthy();
  });

  it("checks the whole selection by id before sending and drops who joined meanwhile (CR-307)", async () => {
    let inGroup: number[] = [];
    const transport = mockTransport({
      ...routes(),
      [MEMBERS]: (request) => routes(inGroup)[MEMBERS](request),
      "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
        pagedList(
          "memberships",
          PEOPLE.map((user) => ({ userId: user.id, user })),
          ({ userId }) => userId,
        ),
      [BULK_POST]: () => jsonResponse({ memberships: [] }, 201),
    });
    renderApp({ route: NEW_MEMBERS });
    // Persona 002 is picked on page 1, then the user moves to page 2.
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Persona 002/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Persona 021/ }),
    );
    // Meanwhile somebody else adds Persona 002 to the group: page 2 cannot tell.
    inGroup = [2];
    fireEvent.click(
      screen.getByRole("button", { name: "Agregar 2 personas al grupo" }),
    );
    await screen.findByText(/Persona 002 ya no se puede agregar al grupo/);
    // Nothing was sent: no request, so no 409.
    expect(transport.calls(BULK_POST)).toHaveLength(0);
    expect(screen.getByText("1 persona seleccionada.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Persona 002" })).toBeNull();

    // Confirming the final list sends only who can still be added.
    fireEvent.click(
      screen.getByRole("button", { name: "Agregar 1 persona al grupo" }),
    );
    await waitFor(() => expect(transport.calls(BULK_POST)).toHaveLength(1));
    const sent = transport.calls(BULK_POST)[0]!.body as {
      members: Array<{ userId: string }>;
    };
    expect(sent.members.map(({ userId }) => userId)).toEqual([uuid(21)]);
  });

  it("says so when every person of the page is already in the group", async () => {
    mockTransport(
      routes(Array.from({ length: 20 }, (_unused, index) => index + 1)),
    );
    renderApp({ route: NEW_MEMBERS });
    expect(
      await screen.findByText(
        "Todas las personas de esta página ya están en el grupo.",
      ),
    ).toBeTruthy();
    // The next page still has people to offer.
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(
      await screen.findByRole("checkbox", { name: /Persona 021/ }),
    ).toBeTruthy();
  });

  it("lands on the last page when ?page= is past the end", async () => {
    mockTransport(routes());
    renderApp({ route: `${NEW_MEMBERS}?page=99` });
    await screen.findByRole("checkbox", { name: /Persona 241/ });
    expect(window.location.search).toBe("?page=13");
  });
});
