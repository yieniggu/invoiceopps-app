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

const ORG = "00000000-0000-4000-9000-000000000001";
const GROUP = "00000000-0000-4000-a000-000000000097";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const north = { id: ORG, name: "Academia Norte" };
const accounting = {
  id: GROUP,
  organizationId: ORG,
  name: "Contabilidad",
  description: null,
};
const admin = profileFixture({ memberships: [membership(north, "ADMIN")] });
const NO_FLAGS = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};
const PEOPLE = Array.from({ length: 5 }, (_unused, index) => ({
  id: uuid(index + 1),
  name: `Persona ${String(index + 1).padStart(3, "0")}`,
  rut: `${10_000_001 + index}5`,
  role: "USER" as const,
}));

const USERS = `GET /api/v1/organizations/${ORG}/users`;
const MEMBERS = `GET /api/v1/organizations/${ORG}/groups/${GROUP}/memberships`;
const ORG_MEMBERSHIPS = `GET /api/v1/organizations/${ORG}/memberships`;
const BULK_POST = `POST /api/v1/organizations/${ORG}/groups/${GROUP}/memberships/bulk`;
const NEW_MEMBERS = `/organizations/${ORG}/groups/${GROUP}/members/new`;

/** A promise settled from the test, to hold a request in flight. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

function routes({
  inGroup = () => [] as number[],
  orgMemberships,
}: {
  inGroup?: () => number[];
  orgMemberships?: Parameters<typeof mockTransport>[0][string];
} = {}) {
  return {
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: admin }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    [`GET /api/v1/organizations/${ORG}/groups`]: () =>
      jsonResponse({ groups: [accounting] }),
    [USERS]: pagedList("users", PEOPLE, ({ id }) => id),
    [MEMBERS]: (request: Parameters<ReturnType<typeof pagedList>>[0]) =>
      pagedList(
        "memberships",
        inGroup().map((n) => ({
          userId: uuid(n),
          groupId: GROUP,
          organizationId: ORG,
          permissions: NO_FLAGS,
          user: PEOPLE[n - 1],
        })),
        ({ userId }) => userId,
      )(request),
    [ORG_MEMBERSHIPS]:
      orgMemberships ??
      pagedList(
        "memberships",
        PEOPLE.map((user) => ({ userId: user.id, user })),
        ({ userId }) => userId,
      ),
    [BULK_POST]: () => jsonResponse({ memberships: [] }, 201),
  };
}

const pick = async (n: number) =>
  fireEvent.click(
    await screen.findByRole("checkbox", {
      name: new RegExp(`Persona 00${n}`),
    }),
  );
const submit = (label: RegExp | string) =>
  fireEvent.click(screen.getByRole("button", { name: label }));

describe("AddMembersForm pre-check (CR-312/CR-313)", () => {
  it("sends nothing when the page is left while the selection is being checked (CR-312)", async () => {
    const hold = gate();
    const transport = mockTransport(
      routes({
        orgMemberships: async (request) => {
          await hold.opened;
          return pagedList(
            "memberships",
            PEOPLE.map((user) => ({ userId: user.id, user })),
            ({ userId }) => userId,
          )(request);
        },
      }),
    );
    const view = renderApp({ route: NEW_MEMBERS });
    await pick(1);
    submit("Agregar 1 persona al grupo");
    await screen.findByRole("button", { name: /Comprobando/ });
    view.unmount();
    hold.open();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(transport.calls(BULK_POST)).toHaveLength(0);
  });

  it("shows Comprobando and disables the submit while checking", async () => {
    const hold = gate();
    mockTransport(
      routes({
        orgMemberships: async (request) => {
          await hold.opened;
          return pagedList(
            "memberships",
            PEOPLE.map((user) => ({ userId: user.id, user })),
            ({ userId }) => userId,
          )(request);
        },
      }),
    );
    renderApp({ route: NEW_MEMBERS });
    await pick(1);
    submit("Agregar 1 persona al grupo");
    const button = await screen.findByRole("button", { name: /Comprobando/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    hold.open();
    await waitFor(() => expect(screen.queryByText(/Comprobando/)).toBeNull());
  });

  it("goes ahead with the request when the check itself fails", async () => {
    const transport = mockTransport(
      routes({
        orgMemberships: () => errorResponse(500, "INTERNAL_ERROR"),
      }),
    );
    renderApp({ route: NEW_MEMBERS });
    await pick(1);
    submit("Agregar 1 persona al grupo");
    await waitFor(() => expect(transport.calls(BULK_POST)).toHaveLength(1));
  });

  it("says so and disables the submit when everybody was pruned", async () => {
    let inGroup: number[] = [];
    const transport = mockTransport(routes({ inGroup: () => inGroup }));
    renderApp({ route: NEW_MEMBERS });
    await pick(1);
    inGroup = [1];
    submit("Agregar 1 persona al grupo");
    await screen.findByText(/Persona 001 ya no se puede agregar al grupo/);
    expect(transport.calls(BULK_POST)).toHaveLength(0);
    const button = screen.getByRole("button", {
      name: "Agregar personas al grupo",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("clears the pruned message when the selection changes", async () => {
    let inGroup: number[] = [];
    mockTransport(routes({ inGroup: () => inGroup }));
    renderApp({ route: NEW_MEMBERS });
    await pick(1);
    inGroup = [1];
    submit("Agregar 1 persona al grupo");
    await screen.findByText(/Persona 001 ya no se puede agregar al grupo/);
    await pick(2);
    expect(screen.queryByText(/Persona 001 ya no se puede agregar/)).toBeNull();
  });

  it("moves focus to the pruned message so keyboard users do not lose their place", async () => {
    let inGroup: number[] = [];
    mockTransport(routes({ inGroup: () => inGroup }));
    renderApp({ route: NEW_MEMBERS });
    await pick(1);
    await pick(2);
    inGroup = [1];
    submit("Agregar 2 personas al grupo");
    const alert = await screen.findByText(
      /Persona 001 ya no se puede agregar al grupo/,
    );
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.getAttribute("tabindex")).toBe("-1");
  });
});
