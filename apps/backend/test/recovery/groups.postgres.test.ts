import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { createGroupCatalogService } from "../../src/features/groups/services.js";
import {
  ALL_FLAGS,
  membershipFixtures,
  NO_FLAGS,
  type Scenario,
  type TestUser,
} from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

const url = recoveryTestDatabaseUrl();

const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const app = createApp(database, auth);
const {
  makeUser,
  makeOrg,
  makeGroup,
  addToGroup,
  join,
  cookieFor,
  call,
  designatePlatformAdministrator,
  waitUntilBlocked,
  scenario,
} = membershipFixtures({ prisma, client, auth, app, url });

let platform: TestUser;
let platformCookie: string;

beforeAll(async () => {
  await client.connect();
  platform = await makeUser("Platform Administrator");
  await designatePlatformAdministrator(platform.id);
  platformCookie = await cookieFor(platform);
});
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

describe("RP0-07 GET /organizations/{organizationId}/groups", () => {
  it("lists every group for an ADMIN and only own groups for a USER, with a group DTO without flags", async () => {
    const s = await scenario();
    const second = await makeGroup(s.org.id, "Zeta");
    await addToGroup(second.id, s.member.id, s.org.id, { readInvoices: true });

    const asAdmin = await call(
      "get",
      `/organizations/${s.org.id}/groups`,
      await cookieFor(s.admin),
    );
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.groups).toEqual([
      {
        id: s.group.id,
        organizationId: s.org.id,
        name: "Finance",
        description: null,
      },
      {
        id: second.id,
        organizationId: s.org.id,
        name: "Zeta",
        description: null,
      },
    ]);

    const asMember = await call(
      "get",
      `/organizations/${s.org.id}/groups`,
      await cookieFor(s.member),
    );
    expect(asMember.status).toBe(200);
    expect(
      (asMember.body.groups as Array<{ id: string }>).map((group) => group.id),
    ).toEqual([second.id]);
  });

  it("lists every group of any existing organization for the platform administrator", async () => {
    const s = await scenario();
    const response = await call(
      "get",
      `/organizations/${s.org.id}/groups`,
      platformCookie,
    );
    expect(response.status).toBe(200);
    expect(
      (response.body.groups as Array<{ id: string }>).map((group) => group.id),
    ).toEqual([s.group.id]);

    const missing = await call(
      "get",
      "/organizations/00000000-0000-4000-8000-000000000000/groups",
      platformCookie,
    );
    expect(missing.status).toBe(404);
  });

  it("answers 404 to a non-member", async () => {
    const s = await scenario();
    const response = await call(
      "get",
      `/organizations/${s.org.id}/groups`,
      await cookieFor(s.outsider),
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

describe("CR-260 the legacy GET /groups exposes no people", () => {
  // The legacy route is mounted only when the catalog service is wired, as
  // server.ts does.
  const legacy = membershipFixtures({
    prisma,
    client,
    auth,
    app: createApp(database, auth, {
      groups: createGroupCatalogService(prisma),
    }),
    url,
  }).call;

  it("lists the caller's groups to a plain USER and an ADMIN without any member name or RUT", async () => {
    const s = await scenario();
    await addToGroup(s.group.id, s.admin.id, s.org.id);
    await addToGroup(s.group.id, s.member.id, s.org.id);
    const expected = [
      {
        id: s.group.id,
        name: "Finance",
        description: null,
        organization: { id: s.org.id, name: s.org.name },
      },
    ];

    for (const actor of [s.member, s.admin]) {
      const response = await legacy("get", "/groups", await cookieFor(actor));
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ groups: expected });
      const text = JSON.stringify(response.body);
      for (const person of [s.admin, s.member]) {
        expect(text).not.toContain(person.id);
        expect(text).not.toContain(person.rut);
        expect(text).not.toContain(person.rawRut);
      }
      expect(text).not.toContain("Ada Admin");
      expect(text).not.toContain("Uma User");
    }
  });
});

describe("RP0-07 POST /organizations/{organizationId}/groups", () => {
  it("creates a group without flags and does not add the creator", async () => {
    const s = await scenario();

    const response = await call(
      "post",
      `/organizations/${s.org.id}/groups`,
      await cookieFor(s.admin),
      { name: "Operations", description: "Back office" },
    );

    expect(response.status).toBe(201);
    expect(response.body.group).toEqual({
      id: expect.any(String),
      organizationId: s.org.id,
      name: "Operations",
      description: "Back office",
    });
    expect(
      await prisma.groupMembership.count({
        where: { groupId: response.body.group.id },
      }),
    ).toBe(0);
  });

  it.each([
    ["a permissions field", { name: "X", permissions: ALL_FLAGS }],
    ["a flag at the top level", { name: "X", readInvoices: true }],
    ["a missing name", { description: "no name" }],
  ])("rejects %s with 400 and persists nothing", async (_label, body) => {
    const s = await scenario();
    const before = await prisma.group.count({
      where: { organizationId: s.org.id },
    });

    const response = await call(
      "post",
      `/organizations/${s.org.id}/groups`,
      await cookieFor(s.admin),
      body,
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(
      await prisma.group.count({ where: { organizationId: s.org.id } }),
    ).toBe(before);
  });

  it("answers 403 to a USER member, 404 to outsiders and lets the platform administrator create", async () => {
    const s = await scenario();
    const send = (cookie: string) =>
      call("post", `/organizations/${s.org.id}/groups`, cookie, { name: "N" });

    expect((await send(await cookieFor(s.member))).status).toBe(403);
    expect((await send(await cookieFor(s.outsider))).status).toBe(404);
    expect(
      await prisma.group.count({ where: { organizationId: s.org.id } }),
    ).toBe(1);
    expect((await send(platformCookie)).status).toBe(201);
    expect(
      await prisma.group.count({ where: { organizationId: s.org.id } }),
    ).toBe(2);
  });
});

describe("RP0-22 the group-level PATCH is gone", () => {
  it("answers 404 and changes nothing", async () => {
    const s = await scenario();
    const response = await call(
      "patch",
      `/organizations/${s.org.id}/groups/${s.group.id}`,
      await cookieFor(s.admin),
      { permissions: ALL_FLAGS },
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

describe("RP0-07 group memberships", () => {
  const base = (s: Scenario) =>
    `/organizations/${s.org.id}/groups/${s.group.id}/memberships`;

  it("adds an organization member with default flags, rejects duplicates and non-members, lists and removes", async () => {
    const s = await scenario();
    const cookie = await cookieFor(s.admin);

    const created = await call("post", base(s), cookie, {
      userId: s.member.id,
    });
    expect(created.status).toBe(201);
    expect(created.body.membership).toEqual({
      userId: s.member.id,
      groupId: s.group.id,
      organizationId: s.org.id,
      permissions: NO_FLAGS,
    });

    const duplicate = await call("post", base(s), cookie, {
      userId: s.member.id,
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("MEMBERSHIP_CONFLICT");

    const notInOrg = await call("post", base(s), cookie, {
      userId: s.outsider.id,
    });
    expect(notInOrg.status).toBe(409);
    expect(notInOrg.body.error.code).toBe("ORGANIZATION_MEMBERSHIP_REQUIRED");

    const listed = await call("get", base(s), cookie);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    expect(listed.body.memberships).toEqual([
      {
        userId: s.member.id,
        groupId: s.group.id,
        organizationId: s.org.id,
        permissions: NO_FLAGS,
        user: { id: s.member.id, name: "Uma User", rut: s.member.rawRut },
      },
    ]);

    const removed = await call("delete", `${base(s)}/${s.member.id}`, cookie);
    expect(removed.status).toBe(204);
    const again = await call("delete", `${base(s)}/${s.member.id}`, cookie);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("NOT_FOUND");
  });

  it("paginates the group memberships by name with bounds", async () => {
    const s = await scenario();
    const cookie = await cookieFor(s.admin);
    const members = [
      await makeUser("Ana Group"),
      await makeUser("Bob Group 1"),
      await makeUser("Bob Group 2"),
    ];
    for (const user of members) {
      await join(user.id, s.org.id, "USER");
      await addToGroup(s.group.id, user.id, s.org.id, NO_FLAGS);
    }
    const expected = members.map((member) => member.id);

    const pages = [
      await call("get", `${base(s)}?page=1&pageSize=2`, cookie),
      await call("get", `${base(s)}?page=2&pageSize=2`, cookie),
    ];
    const ids = (r: { body: { memberships: Array<{ userId: string }> } }) =>
      r.body.memberships.map((m) => m.userId);

    expect(pages.map((p) => p.body.total)).toEqual([3, 3]);
    expect(pages[1]!.body).toMatchObject({ page: 2, pageSize: 2 });
    expect([...ids(pages[0]!), ...ids(pages[1]!)]).toEqual(expected);
    expect((await call("get", `${base(s)}?pageSize=100`, cookie)).status).toBe(
      200,
    );
    for (const bad of ["pageSize=101", "page=0", "page=10001", "foo=1"]) {
      expect((await call("get", `${base(s)}?${bad}`, cookie)).status).toBe(400);
    }
  });

  it("filters the group memberships by userIds, past the first page, with the same item shape and order", async () => {
    const s = await scenario();
    const cookie = await cookieFor(s.admin);
    const members = [
      await makeUser("Ana Group"),
      await makeUser("Bob Group"),
      await makeUser("Zed Group"),
    ];
    for (const user of members) {
      await join(user.id, s.org.id, "USER");
      await addToGroup(s.group.id, user.id, s.org.id, NO_FLAGS);
    }
    const zed = members[2]!;
    const plain = await call("get", `${base(s)}?pageSize=1`, cookie);
    expect(plain.body.memberships[0].userId).not.toBe(zed.id);

    const filtered = await call(
      "get",
      `${base(s)}?pageSize=1&userIds=${zed.id}`,
      cookie,
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body).toMatchObject({ page: 1, pageSize: 1, total: 1 });
    const full = await call("get", base(s), cookie);
    expect(filtered.body.memberships[0]).toEqual(
      full.body.memberships.find(
        (m: { userId: string }) => m.userId === zed.id,
      ),
    );

    // Several ids keep the ordering; people who are not in the group (or not
    // in the organization) are simply absent.
    const missing = "00000000-0000-4000-8000-000000000000";
    const several = await call(
      "get",
      `${base(s)}?userIds=${zed.id},${members[0]!.id},${missing},${s.outsider.id}`,
      cookie,
    );
    expect(several.body.total).toBe(2);
    expect(
      several.body.memberships.map((m: { userId: string }) => m.userId),
    ).toEqual([members[0]!.id, zed.id]);

    // Same authority: a plain member is still refused.
    const memberCookie = await cookieFor(s.member);
    expect(
      (await call("get", `${base(s)}?userIds=${zed.id}`, memberCookie)).status,
    ).toBe(403);
  });

  it("stores the permissions sent when adding a member and lists them", async () => {
    const s = await scenario();
    const cookie = await cookieFor(s.admin);
    const sent = { ...NO_FLAGS, readInvoices: true, deleteOwnInvoices: true };

    const created = await call("post", base(s), cookie, {
      userId: s.member.id,
      permissions: sent,
    });

    expect(created.status).toBe(201);
    expect(created.body.membership.permissions).toEqual(sent);
    const listed = await call("get", base(s), cookie);
    expect(listed.body.memberships[0].permissions).toEqual(sent);
  });

  it.each([
    ["a partial permissions object", { permissions: { readInvoices: true } }],
    ["a flag at the top level", { readInvoices: true }],
    ["a non-boolean flag", { permissions: { ...NO_FLAGS, readInvoices: 1 } }],
  ])(
    "rejects %s in the membership payload and persists nothing",
    async (_label, extra) => {
      const s = await scenario();

      const response = await call("post", base(s), await cookieFor(s.admin), {
        userId: s.member.id,
        ...extra,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(
        await prisma.groupMembership.count({ where: { groupId: s.group.id } }),
      ).toBe(0);
    },
  );

  it("answers 403 to a USER member and 404 to outsiders and a group of another organization", async () => {
    const s = await scenario();
    const foreignOrg = await makeOrg("foreign-membership");
    const foreignGroup = await makeGroup(foreignOrg.id, "Foreign");
    const body = { userId: s.member.id };

    expect(
      (await call("post", base(s), await cookieFor(s.member), body)).status,
    ).toBe(403);
    expect(
      (await call("post", base(s), await cookieFor(s.outsider), body)).status,
    ).toBe(404);
    expect((await call("get", base(s), await cookieFor(s.member))).status).toBe(
      403,
    );
    for (const cookie of [await cookieFor(s.admin), platformCookie]) {
      expect(
        (
          await call(
            "post",
            `/organizations/${s.org.id}/groups/${foreignGroup.id}/memberships`,
            cookie,
            body,
          )
        ).status,
      ).toBe(404);
    }
    expect(
      await prisma.groupMembership.count({
        where: { organizationId: s.org.id },
      }),
    ).toBe(0);
  });

  it("lets the platform administrator add, list and remove members", async () => {
    const s = await scenario();

    const added = await call("post", base(s), platformCookie, {
      userId: s.member.id,
    });
    expect(added.status).toBe(201);
    expect((await call("get", base(s), platformCookie)).status).toBe(200);
    expect(
      (await call("delete", `${base(s)}/${s.member.id}`, platformCookie))
        .status,
    ).toBe(204);
  });
});

describe("RP0-22 serialization on membership rows", () => {
  it("makes a group permission PUT wait for a transaction holding that group membership", async () => {
    const s = await scenario();
    await addToGroup(s.group.id, s.member.id, s.org.id);
    const cookie = await cookieFor(s.admin);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        'SELECT id FROM "GroupMembership" WHERE "groupId" = $1 AND "userId" = $2 FOR SHARE',
        [s.group.id, s.member.id],
      );

      let settled = false;
      const pending = call(
        "put",
        `/organizations/${s.org.id}/groups/${s.group.id}/memberships/${s.member.id}/permissions`,
        cookie,
        { permissions: ALL_FLAGS },
      ).then((response) => {
        settled = true;
        return response;
      });

      await waitUntilBlocked('%FROM "GroupMembership"%FOR UPDATE%');
      expect(settled).toBe(false);
      expect(
        (
          await prisma.groupMembership.findFirstOrThrow({
            where: { groupId: s.group.id, userId: s.member.id },
          })
        ).readInvoices,
      ).toBe(false);

      await holder.query("COMMIT");
      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.body.membership.permissions).toEqual(ALL_FLAGS);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("makes organization membership removal wait for an invoice-write share lock on that membership", async () => {
    const s = await scenario();
    await addToGroup(s.group.id, s.member.id, s.org.id);
    const cookie = await cookieFor(s.admin);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        'SELECT id FROM "OrganizationMembership" WHERE "userId" = $1 AND "organizationId" = $2 FOR SHARE',
        [s.member.id, s.org.id],
      );

      let settled = false;
      const pending = call(
        "delete",
        `/organizations/${s.org.id}/memberships/${s.member.id}`,
        cookie,
      ).then((response) => {
        settled = true;
        return response;
      });

      await waitUntilBlocked('%FROM "OrganizationMembership"%FOR UPDATE%');
      expect(settled).toBe(false);
      expect(
        await prisma.organizationMembership.count({
          where: { userId: s.member.id, organizationId: s.org.id },
        }),
      ).toBe(1);

      await holder.query("COMMIT");
      expect((await pending).status).toBe(204);
      expect(
        await prisma.groupMembership.count({
          where: { userId: s.member.id, organizationId: s.org.id },
        }),
      ).toBe(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });
});
