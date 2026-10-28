import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { loadEffectivePermissions } from "../../src/features/groups/invoice-permissions.js";
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
  join,
  makeGroup,
  addToGroup,
  cookieFor,
  call,
  designatePlatformAdministrator,
  waitUntilBlocked,
  scenario,
} = membershipFixtures({ prisma, client, auth, app, url });

const MISSING = "00000000-0000-4000-8000-000000000000";

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

const orgPath = (s: Scenario, userId: string) =>
  `/organizations/${s.org.id}/memberships/${userId}/permissions`;
const groupPath = (s: Scenario, userId: string, groupId = s.group.id) =>
  `/organizations/${s.org.id}/groups/${groupId}/memberships/${userId}/permissions`;

async function memberScenario() {
  const s = await scenario();
  await addToGroup(s.group.id, s.member.id, s.org.id);
  return s;
}

async function storedFlags(userId: string, organizationId: string) {
  const row = await prisma.organizationMembership.findUniqueOrThrow({
    where: { userId_organizationId: { userId, organizationId } },
  });
  return {
    readInvoices: row.readInvoices,
    createInvoices: row.createInvoices,
    deleteOwnInvoices: row.deleteOwnInvoices,
    deleteOthersInvoices: row.deleteOthersInvoices,
  };
}

async function storedGroupFlags(userId: string, groupId: string) {
  const row = await prisma.groupMembership.findFirstOrThrow({
    where: { userId, groupId },
  });
  return {
    readInvoices: row.readInvoices,
    createInvoices: row.createInvoices,
    deleteOwnInvoices: row.deleteOwnInvoices,
    deleteOthersInvoices: row.deleteOthersInvoices,
  };
}

describe("RP0-22 PUT organization membership permissions", () => {
  it("replaces the four flags atomically and answers the membership DTO", async () => {
    const s = await memberScenario();
    const cookie = await cookieFor(s.admin);
    const sent = { ...NO_FLAGS, createInvoices: true };

    const first = await call("put", orgPath(s, s.member.id), cookie, {
      permissions: sent,
    });
    expect(first.status).toBe(200);
    expect(first.body.membership).toEqual({
      userId: s.member.id,
      organizationId: s.org.id,
      role: "USER",
      permissions: sent,
    });

    // Full replace, no implication between flags: read stays false.
    const second = await call("put", orgPath(s, s.member.id), cookie, {
      permissions: { ...NO_FLAGS, deleteOthersInvoices: true },
    });
    expect(second.status).toBe(200);
    expect(await storedFlags(s.member.id, s.org.id)).toEqual({
      ...NO_FLAGS,
      deleteOthersInvoices: true,
    });
  });

  it("allows an organization ADMIN and the platform administrator, and nobody else", async () => {
    const s = await memberScenario();
    const body = { permissions: { ...NO_FLAGS, readInvoices: true } };

    expect(
      (
        await call(
          "put",
          orgPath(s, s.member.id),
          await cookieFor(s.member),
          body,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "put",
          orgPath(s, s.member.id),
          await cookieFor(s.outsider),
          body,
        )
      ).status,
    ).toBe(404);
    expect(await storedFlags(s.member.id, s.org.id)).toEqual(NO_FLAGS);

    expect(
      (
        await call(
          "put",
          orgPath(s, s.member.id),
          await cookieFor(s.admin),
          body,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call("put", orgPath(s, s.member.id), platformCookie, {
          permissions: ALL_FLAGS,
        })
      ).status,
    ).toBe(200);
    expect(await storedFlags(s.member.id, s.org.id)).toEqual(ALL_FLAGS);
  });

  it("answers 404 for a foreign organization ADMIN, a missing organization and a user who is not a member", async () => {
    const s = await memberScenario();
    const otherOrg = await makeOrg("other");
    const otherAdmin = await makeUser();
    await join(otherAdmin.id, otherOrg.id, "ADMIN");
    const body = { permissions: ALL_FLAGS };

    expect(
      (
        await call(
          "put",
          orgPath(s, s.member.id),
          await cookieFor(otherAdmin),
          body,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          "put",
          `/organizations/${MISSING}/memberships/${s.member.id}/permissions`,
          platformCookie,
          body,
        )
      ).status,
    ).toBe(404);
    const notMember = await call(
      "put",
      orgPath(s, s.outsider.id),
      await cookieFor(s.admin),
      body,
    );
    expect(notMember.status).toBe(404);
    expect(notMember.body.error.code).toBe("NOT_FOUND");
    expect(await storedFlags(s.member.id, s.org.id)).toEqual(NO_FLAGS);
  });

  it("answers 403 ONBOARDING_REQUIRED while the actor still has a temporary password", async () => {
    const s = await memberScenario();
    await prisma.user.update({
      where: { id: s.admin.id },
      data: {
        mustChangePassword: true,
        temporaryPasswordExpiresAt: new Date(Date.now() + 3_600_000),
      },
    });

    const response = await call(
      "put",
      orgPath(s, s.member.id),
      await cookieFor(s.admin),
      { permissions: ALL_FLAGS },
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ONBOARDING_REQUIRED");
    expect(await storedFlags(s.member.id, s.org.id)).toEqual(NO_FLAGS);
  });

  it.each([
    ["a missing flag", { permissions: { readInvoices: true } }],
    [
      "a non-boolean flag",
      { permissions: { ...NO_FLAGS, readInvoices: "yes" } },
    ],
    ["a missing permissions object", {}],
    ["an extra top-level field", { permissions: NO_FLAGS, role: "ADMIN" }],
    [
      "an extra field inside permissions",
      { permissions: { ...NO_FLAGS, adminOverride: true } },
    ],
  ])("rejects %s with 400 and persists nothing", async (_label, body) => {
    const s = await memberScenario();
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
      data: { createInvoices: true },
    });

    const response = await call(
      "put",
      orgPath(s, s.member.id),
      await cookieFor(s.admin),
      body,
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(await storedFlags(s.member.id, s.org.id)).toEqual({
      ...NO_FLAGS,
      createInvoices: true,
    });
  });

  it("applies from the next request of that user only, leaving other members and groups alone", async () => {
    const s = await memberScenario();
    const other = await makeUser();
    await join(other.id, s.org.id, "USER");
    const memberCookie = await cookieFor(s.member);
    const otherCookie = await cookieFor(other);
    const flagsOf = async (cookie: string) => {
      const profile = await call("get", "/auth/profile", cookie);
      return profile.body.profile.memberships[0].permissions;
    };
    expect(await flagsOf(memberCookie)).toEqual(NO_FLAGS);

    await call("put", orgPath(s, s.member.id), await cookieFor(s.admin), {
      permissions: { ...NO_FLAGS, readInvoices: true },
    });

    expect(await flagsOf(memberCookie)).toEqual({
      ...NO_FLAGS,
      readInvoices: true,
    });
    expect(await flagsOf(otherCookie)).toEqual(NO_FLAGS);
    expect(await storedGroupFlags(s.member.id, s.group.id)).toEqual(NO_FLAGS);
  });
});

describe("RP0-22 PUT group membership permissions", () => {
  it("replaces the four flags and answers the group membership DTO", async () => {
    const s = await memberScenario();

    const response = await call(
      "put",
      groupPath(s, s.member.id),
      await cookieFor(s.admin),
      { permissions: { ...NO_FLAGS, deleteOwnInvoices: true } },
    );

    expect(response.status).toBe(200);
    expect(response.body.membership).toEqual({
      userId: s.member.id,
      groupId: s.group.id,
      organizationId: s.org.id,
      permissions: { ...NO_FLAGS, deleteOwnInvoices: true },
    });
    expect(await storedFlags(s.member.id, s.org.id)).toEqual(NO_FLAGS);
  });

  it("allows an organization ADMIN and the platform administrator, and nobody else", async () => {
    const s = await memberScenario();
    const body = { permissions: { ...NO_FLAGS, readInvoices: true } };

    expect(
      (
        await call(
          "put",
          groupPath(s, s.member.id),
          await cookieFor(s.member),
          body,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "put",
          groupPath(s, s.member.id),
          await cookieFor(s.outsider),
          body,
        )
      ).status,
    ).toBe(404);
    expect(await storedGroupFlags(s.member.id, s.group.id)).toEqual(NO_FLAGS);
    expect(
      (
        await call(
          "put",
          groupPath(s, s.member.id),
          await cookieFor(s.admin),
          body,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call("put", groupPath(s, s.member.id), platformCookie, {
          permissions: ALL_FLAGS,
        })
      ).status,
    ).toBe(200);
    expect(await storedGroupFlags(s.member.id, s.group.id)).toEqual(ALL_FLAGS);
  });

  it("answers 404 for a foreign ADMIN, a group of another organization, a missing group and a user not in the group", async () => {
    const s = await memberScenario();
    const otherOrg = await makeOrg("other-group");
    const otherAdmin = await makeUser();
    await join(otherAdmin.id, otherOrg.id, "ADMIN");
    const foreignGroup = await makeGroup(otherOrg.id, "Foreign");
    const body = { permissions: ALL_FLAGS };

    expect(
      (
        await call(
          "put",
          groupPath(s, s.member.id),
          await cookieFor(otherAdmin),
          body,
        )
      ).status,
    ).toBe(404);
    const adminCookie = await cookieFor(s.admin);
    for (const groupId of [foreignGroup.id, MISSING]) {
      const response = await call(
        "put",
        groupPath(s, s.member.id, groupId),
        adminCookie,
        body,
      );
      expect(response.status).toBe(404);
    }
    // An organization member who is not in this group.
    const notInGroup = await call(
      "put",
      groupPath(s, s.admin.id),
      adminCookie,
      body,
    );
    expect(notInGroup.status).toBe(404);
    expect(notInGroup.body.error.code).toBe("NOT_FOUND");
    expect(await storedGroupFlags(s.member.id, s.group.id)).toEqual(NO_FLAGS);
  });

  it.each([
    ["a missing flag", { permissions: { createInvoices: true } }],
    ["a null flag", { permissions: { ...NO_FLAGS, readInvoices: null } }],
    ["an extra field", { permissions: NO_FLAGS, groupId: "x" }],
  ])("rejects %s with 400 and persists nothing", async (_label, body) => {
    const s = await memberScenario();

    const response = await call(
      "put",
      groupPath(s, s.member.id),
      await cookieFor(s.admin),
      body,
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(await storedGroupFlags(s.member.id, s.group.id)).toEqual(NO_FLAGS);
  });
});

describe("RP0-22 PATCH organization membership rejects permissions", () => {
  it("answers 400 and neither the role nor the flags change", async () => {
    const s = await memberScenario();

    const response = await call(
      "patch",
      `/organizations/${s.org.id}/memberships/${s.member.id}`,
      await cookieFor(s.admin),
      { role: "ADMIN", permissions: ALL_FLAGS },
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    const row = await prisma.organizationMembership.findUniqueOrThrow({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
    });
    expect(row.role).toBe("USER");
    expect(await storedFlags(s.member.id, s.org.id)).toEqual(NO_FLAGS);
  });
});

describe("RP0-22 POST organization membership with permissions", () => {
  it("stores the permissions sent and defaults to all false when absent", async () => {
    const s = await scenario();
    const cookie = await cookieFor(s.admin);
    const withFlags = await makeUser();
    const withoutFlags = await makeUser();
    const sent = { ...NO_FLAGS, readInvoices: true, deleteOwnInvoices: true };

    const a = await call(
      "post",
      `/organizations/${s.org.id}/memberships`,
      cookie,
      {
        rut: withFlags.rut,
        role: "USER",
        permissions: sent,
      },
    );
    const b = await call(
      "post",
      `/organizations/${s.org.id}/memberships`,
      cookie,
      {
        rut: withoutFlags.rut,
        role: "USER",
      },
    );

    expect(a.status).toBe(201);
    expect(a.body.membership.permissions).toEqual(sent);
    expect(b.status).toBe(201);
    expect(b.body.membership.permissions).toEqual(NO_FLAGS);
    expect(await storedFlags(withFlags.id, s.org.id)).toEqual(sent);
  });

  it("lists permissions and groups per member in one response", async () => {
    const s = await scenario();
    const second = await makeGroup(s.org.id, "Alpha");
    await addToGroup(s.group.id, s.member.id, s.org.id, {
      createInvoices: true,
      deleteOwnInvoices: true,
    });
    await addToGroup(second.id, s.member.id, s.org.id);
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
      data: { readInvoices: true },
    });

    const response = await call(
      "get",
      `/organizations/${s.org.id}/memberships`,
      await cookieFor(s.admin),
    );

    expect(response.status).toBe(200);
    const member = response.body.memberships.find(
      (membership: { userId: string }) => membership.userId === s.member.id,
    );
    expect(member.permissions).toEqual({ ...NO_FLAGS, readInvoices: true });
    // Each group carries its own flags: the member page needs no per-group
    // request (CR-217).
    expect(member.groups).toEqual([
      { groupId: second.id, name: "Alpha", permissions: NO_FLAGS },
      {
        groupId: s.group.id,
        name: "Finance",
        permissions: {
          ...NO_FLAGS,
          createInvoices: true,
          deleteOwnInvoices: true,
        },
      },
    ]);
    const admin = response.body.memberships.find(
      (membership: { userId: string }) => membership.userId === s.admin.id,
    );
    expect(admin.groups).toEqual([]);
    expect(admin.permissions).toEqual(NO_FLAGS);
  });
});

describe("RP0-22 effective permissions loader", () => {
  it("never grants invoice permissions to the platform administrator", async () => {
    const s = await scenario();
    await prisma.group.update({ where: { id: s.group.id }, data: {} });
    // No membership at all: nothing, in either scope.
    for (const groupId of [null, s.group.id]) {
      expect(
        await loadEffectivePermissions(prisma, {
          userId: platform.id,
          organizationId: s.org.id,
          groupId,
        }),
      ).toEqual(NO_FLAGS);
    }
    // Administrative authority over the organization changes nothing either.
    expect(
      (
        await call(
          "get",
          `/organizations/${s.org.id}/memberships`,
          platformCookie,
        )
      ).status,
    ).toBe(200);
    expect(
      await loadEffectivePermissions(prisma, {
        userId: platform.id,
        organizationId: s.org.id,
        groupId: s.group.id,
      }),
    ).toEqual(NO_FLAGS);

    // As a plain member the platform administrator has exactly the flags of
    // that membership, no more.
    const memberOrg = await makeOrg("platform-member");
    await join(platform.id, memberOrg.id, "USER");
    expect(
      await loadEffectivePermissions(prisma, {
        userId: platform.id,
        organizationId: memberOrg.id,
        groupId: null,
      }),
    ).toEqual(NO_FLAGS);
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: platform.id,
          organizationId: memberOrg.id,
        },
      },
      data: { createInvoices: true },
    });
    expect(
      await loadEffectivePermissions(prisma, {
        userId: platform.id,
        organizationId: memberOrg.id,
        groupId: null,
      }),
    ).toEqual({ ...NO_FLAGS, createInvoices: true });
  });

  it("gives an organization ADMIN with all flags false nothing, and ORs organization and group flags", async () => {
    const s = await scenario();
    await addToGroup(s.group.id, s.member.id, s.org.id, {
      createInvoices: true,
    });
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
      data: { readInvoices: true },
    });

    for (const groupId of [null, s.group.id]) {
      expect(
        await loadEffectivePermissions(prisma, {
          userId: s.admin.id,
          organizationId: s.org.id,
          groupId,
        }),
      ).toEqual(NO_FLAGS);
    }
    expect(
      await loadEffectivePermissions(prisma, {
        userId: s.member.id,
        organizationId: s.org.id,
        groupId: s.group.id,
      }),
    ).toEqual({ ...NO_FLAGS, readInvoices: true, createInvoices: true });
    // Organization scope ignores the group flags.
    expect(
      await loadEffectivePermissions(prisma, {
        userId: s.member.id,
        organizationId: s.org.id,
        groupId: null,
      }),
    ).toEqual({ ...NO_FLAGS, readInvoices: true });
  });

  it("grants nothing for a disabled organization, pending onboarding or a group the user is not in", async () => {
    const s = await scenario();
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
      data: { readInvoices: true },
    });
    const other = await makeGroup(s.org.id, "Other");
    expect(
      await loadEffectivePermissions(prisma, {
        userId: s.member.id,
        organizationId: s.org.id,
        groupId: other.id,
      }),
    ).toEqual({ ...NO_FLAGS, readInvoices: true });

    await prisma.user.update({
      where: { id: s.member.id },
      data: { mustChangePassword: true },
    });
    expect(
      await loadEffectivePermissions(prisma, {
        userId: s.member.id,
        organizationId: s.org.id,
        groupId: null,
      }),
    ).toEqual(NO_FLAGS);
    await prisma.user.update({
      where: { id: s.member.id },
      data: { mustChangePassword: false },
    });
    await prisma.organization.update({
      where: { id: s.org.id },
      data: { enabled: false },
    });
    expect(
      await loadEffectivePermissions(prisma, {
        userId: s.member.id,
        organizationId: s.org.id,
        groupId: null,
      }),
    ).toEqual(NO_FLAGS);
  });
});

describe("CR-103 administrative races", () => {
  const SETS = {
    first: { ...NO_FLAGS, readInvoices: true, createInvoices: true },
    second: {
      ...NO_FLAGS,
      deleteOwnInvoices: true,
      deleteOthersInvoices: true,
    },
  };

  it("finishes a group permission PUT racing an organization membership removal without deadlock", async () => {
    for (let round = 0; round < 6; round += 1) {
      const s = await memberScenario();
      const cookie = await cookieFor(s.admin);

      const [put, removal] = await Promise.all([
        call("put", groupPath(s, s.member.id), cookie, {
          permissions: SETS.first,
        }),
        call(
          "delete",
          `/organizations/${s.org.id}/memberships/${s.member.id}`,
          cookie,
        ),
      ]);

      expect(removal.status).toBe(204);
      // The PUT either ran before the removal or found no membership.
      expect([200, 404]).toContain(put.status);
      expect(
        await prisma.groupMembership.count({ where: { userId: s.member.id } }),
      ).toBe(0);
      expect(
        await prisma.organizationMembership.count({
          where: { userId: s.member.id, organizationId: s.org.id },
        }),
      ).toBe(0);
    }
  });

  it("orders a removal behind a held group-permission lock and completes both", async () => {
    const s = await memberScenario();
    const cookie = await cookieFor(s.admin);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      // The lock a group permission change takes: organization membership
      // FOR SHARE, then the group membership FOR UPDATE.
      await holder.query("BEGIN");
      await holder.query(
        'SELECT id FROM "OrganizationMembership" WHERE "userId" = $1 AND "organizationId" = $2 FOR SHARE',
        [s.member.id, s.org.id],
      );
      await holder.query(
        'SELECT id FROM "GroupMembership" WHERE "userId" = $1 AND "groupId" = $2 FOR UPDATE',
        [s.member.id, s.group.id],
      );
      await holder.query(
        'UPDATE "GroupMembership" SET "readInvoices" = true WHERE "userId" = $1 AND "groupId" = $2',
        [s.member.id, s.group.id],
      );

      // `.then` sends the request; a supertest call is lazy until then.
      const removal = call(
        "delete",
        `/organizations/${s.org.id}/memberships/${s.member.id}`,
        cookie,
      ).then((response) => response);
      await waitUntilBlocked('%FROM "OrganizationMembership"%FOR UPDATE%');
      await holder.query("COMMIT");

      expect((await removal).status).toBe(204);
      expect(
        await prisma.groupMembership.count({ where: { userId: s.member.id } }),
      ).toBe(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("leaves exactly one of two concurrent PUTs applied, never a mix", async () => {
    for (let round = 0; round < 6; round += 1) {
      const s = await memberScenario();
      const cookie = await cookieFor(s.admin);

      const org = await Promise.all([
        call("put", orgPath(s, s.member.id), cookie, {
          permissions: SETS.first,
        }),
        call("put", orgPath(s, s.member.id), cookie, {
          permissions: SETS.second,
        }),
      ]);
      const group = await Promise.all([
        call("put", groupPath(s, s.member.id), cookie, {
          permissions: SETS.first,
        }),
        call("put", groupPath(s, s.member.id), cookie, {
          permissions: SETS.second,
        }),
      ]);

      for (const response of [...org, ...group]) {
        expect(response.status).toBe(200);
      }
      expect([SETS.first, SETS.second]).toContainEqual(
        await storedFlags(s.member.id, s.org.id),
      );
      expect([SETS.first, SETS.second]).toContainEqual(
        await storedGroupFlags(s.member.id, s.group.id),
      );
    }
  });

  it("serializes a group member add against the organization membership removal", async () => {
    for (let round = 0; round < 6; round += 1) {
      const s = await scenario();
      const cookie = await cookieFor(s.admin);

      const [add, removal] = await Promise.all([
        call(
          "post",
          `/organizations/${s.org.id}/groups/${s.group.id}/memberships`,
          cookie,
          { userId: s.member.id, permissions: SETS.first },
        ),
        call(
          "delete",
          `/organizations/${s.org.id}/memberships/${s.member.id}`,
          cookie,
        ),
      ]);

      expect(removal.status).toBe(204);
      expect([201, 409]).toContain(add.status);
      if (add.status === 409) {
        expect(add.body.error.code).toBe("ORGANIZATION_MEMBERSHIP_REQUIRED");
      }
      // Never a group membership without its organization membership.
      expect(
        await prisma.groupMembership.count({
          where: { userId: s.member.id, organizationId: s.org.id },
        }),
      ).toBe(0);
    }
  });

  it("makes a group member add wait for an organization removal in progress", async () => {
    const s = await scenario();
    const cookie = await cookieFor(s.admin);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        'SELECT id FROM "OrganizationMembership" WHERE "userId" = $1 AND "organizationId" = $2 FOR UPDATE',
        [s.member.id, s.org.id],
      );

      const add = call(
        "post",
        `/organizations/${s.org.id}/groups/${s.group.id}/memberships`,
        cookie,
        { userId: s.member.id },
      ).then((response) => response);
      await waitUntilBlocked('%FROM "OrganizationMembership"%FOR SHARE%');
      await holder.query(
        'DELETE FROM "OrganizationMembership" WHERE "userId" = $1 AND "organizationId" = $2',
        [s.member.id, s.org.id],
      );
      await holder.query("COMMIT");

      const response = await add;
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("ORGANIZATION_MEMBERSHIP_REQUIRED");
      expect(
        await prisma.groupMembership.count({ where: { userId: s.member.id } }),
      ).toBe(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });
});
