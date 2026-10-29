import { useQuery } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "./features/auth/components/SessionProvider";
import { SessionStore } from "./features/auth/session/sessionStore";
import {
  adminUserKey,
  groupMembershipsByIdsKey,
  groupMembershipsKey,
  orgGroupMembershipsPrefix,
  orgUsersKey,
  userBasicKey,
} from "./features/auth/session/queryKeys";
import { useUpdateAdminUser } from "./features/admin/hooks/useAdminUsers";
import {
  useAddGroupMember,
  useGroupMembersByIdsQuery,
  useGroupMembersPageQuery,
  useRemoveGroupMember,
} from "./features/groups/hooks/useGroups";
import { useSavePermissions } from "./features/permissions/hooks/useSavePermissions";
import { uuid } from "./test/ids";
import { renderApp } from "./test/renderApp";
import {
  groupMembershipsPage,
  jsonResponse,
  membership,
  mockTransport,
  NO_PERMISSIONS,
  pagedList,
  profileFixture,
} from "./test/transport";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ME = uuid(1);
const CARLA = uuid(3);
const north = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Academia Norte",
};
const MEMBERS =
  "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships";

function sessionStore() {
  const store = new SessionStore();
  store.accept(store.getSnapshot().client, profileFixture({ id: ME }) as never);
  return store;
}

describe("group membership writes refresh the paged and the by-ids reads (CR-300)", () => {
  function Probe({ action }: { action: "add" | "remove" | "permissions" }) {
    const page = useGroupMembersPageQuery(
      "00000000-0000-4000-9000-000000000001",
      "00000000-0000-4000-a000-000000000097",
      {
        page: 1,
        pageSize: 20,
      },
    );
    const byIds = useGroupMembersByIdsQuery(
      "00000000-0000-4000-9000-000000000001",
      "00000000-0000-4000-a000-000000000097",
      [CARLA],
    );
    const add = useAddGroupMember("00000000-0000-4000-9000-000000000001");
    const remove = useRemoveGroupMember("00000000-0000-4000-9000-000000000001");
    const save = useSavePermissions({
      level: "group",
      organizationId: "00000000-0000-4000-9000-000000000001",
      groupId: "00000000-0000-4000-a000-000000000097",
      userId: CARLA,
    });
    return (
      <>
        <p>{page.data ? "page ready" : "page loading"}</p>
        <p>{byIds.data ? "ids ready" : "ids loading"}</p>
        <button
          type="button"
          onClick={() => {
            if (action === "add")
              add.mutate({
                groupId: "00000000-0000-4000-a000-000000000097",
                userId: CARLA,
                permissions: NO_PERMISSIONS,
              });
            if (action === "remove")
              remove.mutate({
                groupId: "00000000-0000-4000-a000-000000000097",
                userId: CARLA,
              });
            if (action === "permissions")
              save.mutate({ ...NO_PERMISSIONS, readInvoices: true });
          }}
        >
          go
        </button>
      </>
    );
  }

  it.each([
    [
      "add",
      "POST /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships",
    ],
    [
      "remove",
      `DELETE /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships/${CARLA}`,
    ],
    [
      "permissions",
      `PUT /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/memberships/${CARLA}/permissions`,
    ],
  ] as const)(
    "%s: both the paged list and the lookup by ids are read again",
    async (action, write) => {
      const transport = mockTransport({
        [MEMBERS]: () => jsonResponse(groupMembershipsPage([])),
        [write]: () => jsonResponse({ membership: {} }, 200),
        "GET /api/v1/auth/profile": () =>
          jsonResponse({ profile: profileFixture({ id: ME }) }),
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups":
          () => jsonResponse({ groups: [] }),
        "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/memberships":
          () =>
            jsonResponse({ memberships: [], page: 1, pageSize: 100, total: 0 }),
      });
      render(
        <SessionProvider store={sessionStore()}>
          <Probe action={action} />
        </SessionProvider>,
      );
      await screen.findByText("page ready");
      await screen.findByText("ids ready");
      const reads = () => transport.calls(MEMBERS);
      const byIds = () =>
        reads().filter(({ search }) => search.includes("userIds="));
      expect(reads()).toHaveLength(2);

      fireEvent.click(screen.getByRole("button", { name: "go" }));
      await waitFor(() => expect(reads()).toHaveLength(4));
      // One read of each kind again: the page and the by-ids lookup.
      expect(byIds()).toHaveLength(2);
      expect(reads().length - byIds().length).toBe(2);
    },
  );
});

describe("the group members list keeps the page in range (CR-300)", () => {
  const people = Array.from({ length: 21 }, (_unused, index) => ({
    userId: uuid(index + 1),
    groupId: "00000000-0000-4000-a000-000000000097",
    organizationId: "00000000-0000-4000-9000-000000000001",
    permissions: NO_PERMISSIONS,
    user: {
      id: uuid(index + 1),
      name: `Persona ${String(index + 1).padStart(2, "0")}`,
      rut: "190347907",
    },
  }));
  const admin = profileFixture({ memberships: [membership(north, "ADMIN")] });
  const group = {
    id: "00000000-0000-4000-a000-000000000097",
    organizationId: "00000000-0000-4000-9000-000000000001",
    name: "Contabilidad",
    description: null,
  };
  const routes = (list: () => typeof people) => ({
    "GET /api/v1/auth/profile": () => jsonResponse({ profile: admin }),
    "GET /api/v1/groups": () => jsonResponse({ groups: [] }),
    "GET /api/v1/organizations/00000000-0000-4000-9000-000000000001/groups":
      () => jsonResponse({ groups: [group] }),
    [MEMBERS]: (request: { search: string }) =>
      pagedList("memberships", list(), ({ userId }) => userId)(request),
  });
  const LIST =
    "/organizations/00000000-0000-4000-9000-000000000001/groups/00000000-0000-4000-a000-000000000097/members";

  it("moves to the previous page when the last member of the last page is removed", async () => {
    let current = people;
    mockTransport(routes(() => current));
    const { store } = renderApp({ route: `${LIST}?page=2` });
    await screen.findByRole("link", { name: "Persona 21" });
    expect(screen.getByText("Página 2 de 2")).toBeTruthy();

    // The last person leaves; the writes refresh the group's memberships.
    current = people.slice(0, 20);
    await act(async () => {
      await store.getSnapshot().client.invalidateQueries({
        queryKey: groupMembershipsKey(
          ME,
          "00000000-0000-4000-9000-000000000001",
          "00000000-0000-4000-a000-000000000097",
        ),
      });
    });
    await screen.findByRole("link", { name: "Persona 20" });
    expect(screen.getByText("Página 1 de 1")).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(screen.queryByText("No hay miembros en este grupo.")).toBeNull();
  });

  it("lands on the last page when ?page= is past the end", async () => {
    mockTransport(routes(() => people));
    renderApp({ route: `${LIST}?page=9` });
    await screen.findByRole("link", { name: "Persona 21" });
    expect(screen.getByText("Página 2 de 2")).toBeTruthy();
    expect(window.location.search).toBe("?page=2");
  });
});

describe("an admin edit of a person refreshes what shows that person (CR-300)", () => {
  function Edit() {
    const update = useUpdateAdminUser(CARLA);
    const seen = useQuery({
      queryKey: ["probe"],
      queryFn: () => 1,
      enabled: false,
    });
    void seen;
    return (
      <button type="button" onClick={() => update.mutate({ name: "Carla S." })}>
        guardar
      </button>
    );
  }

  it("marks the organization people, the basic profile and the group memberships of the person's organizations stale, and nothing else", async () => {
    const store = sessionStore();
    const client = store.getSnapshot().client;
    const detail = {
      user: { id: CARLA, name: "Carla", rut: "190347907" },
      memberships: [
        {
          organization: {
            id: "00000000-0000-4000-9000-000000000001",
            name: "Norte",
            slug: "norte",
          },
          role: "USER",
          permissions: NO_PERMISSIONS,
          groups: [],
        },
        {
          organization: {
            id: "00000000-0000-4000-9000-000000000002",
            name: "Sur",
            slug: "sur",
          },
          role: "USER",
          permissions: NO_PERMISSIONS,
          groups: [],
        },
      ],
    };
    client.setQueryData(adminUserKey(ME, CARLA), detail);
    const page = { page: 1, pageSize: 20 };
    const seeded = {
      users1: orgUsersKey(ME, "00000000-0000-4000-9000-000000000001", page),
      users2: orgUsersKey(ME, "00000000-0000-4000-9000-000000000002", page),
      usersSearch: orgUsersKey(ME, "00000000-0000-4000-9000-000000000001", {
        ...page,
        search: "carla",
      }),
      basic: userBasicKey(ME, CARLA),
      otherBasic: userBasicKey(ME, uuid(9)),
      group1: groupMembershipsKey(
        ME,
        "00000000-0000-4000-9000-000000000001",
        "00000000-0000-4000-a000-000000000097",
        page,
      ),
      groupIds1: groupMembershipsByIdsKey(
        ME,
        "00000000-0000-4000-9000-000000000001",
        "00000000-0000-4000-a000-000000000097",
        [CARLA],
      ),
      group2: groupMembershipsKey(
        ME,
        "00000000-0000-4000-9000-000000000002",
        "00000000-0000-4000-a000-000000000122",
        page,
      ),
      unrelatedOrg: orgGroupMembershipsPrefix(
        ME,
        "00000000-0000-4000-9000-000000000003",
      ),
    };
    for (const key of Object.values(seeded)) client.setQueryData(key, {});
    mockTransport({
      [`PATCH /api/v1/admin/users/${CARLA}`]: () =>
        jsonResponse({ user: { id: CARLA, name: "Carla S." } }),
    });
    render(
      <SessionProvider store={store}>
        <Edit />
      </SessionProvider>,
    );
    const stale = (key: readonly unknown[]) =>
      client.getQueryState(key)?.isInvalidated === true;
    for (const key of Object.values(seeded)) expect(stale(key)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "guardar" }));
    await waitFor(() => expect(stale(seeded.users1)).toBe(true));

    // The person's organizations: people lists (every page and search), the
    // basic profile and every group membership read.
    expect(stale(seeded.users2)).toBe(true);
    expect(stale(seeded.usersSearch)).toBe(true);
    expect(stale(seeded.basic)).toBe(true);
    expect(stale(seeded.group1)).toBe(true);
    expect(stale(seeded.groupIds1)).toBe(true);
    expect(stale(seeded.group2)).toBe(true);
    // Somebody else's basic profile and an organization the person is not in.
    expect(stale(seeded.otherBasic)).toBe(false);
    expect(stale(seeded.unrelatedOrg)).toBe(false);
  });
});
