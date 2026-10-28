import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import {
  ALL_FLAGS,
  membershipFixtures,
  NO_FLAGS,
  type TestUser,
} from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

// CR-209 / CR-210: every membership change is written to the durable audit
// table in the same transaction as the change, one row per affected member,
// with identifiers and the new flags only; a self-grant is flagged.

const url = recoveryTestDatabaseUrl();
const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const app = createApp(database, auth);
const {
  makeUser,
  join,
  makeGroup,
  addToGroup,
  cookieFor,
  call,
  designatePlatformAdministrator,
  scenario,
} = membershipFixtures({ prisma, client, auth, app, url });

let platform: TestUser;

beforeAll(async () => {
  await client.connect();
  platform = await makeUser("Platform Administrator");
  await designatePlatformAdministrator(platform.id);
});
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

const READ_CREATE = { ...NO_FLAGS, readInvoices: true, createInvoices: true };

async function team(size = 3) {
  const s = await scenario();
  const members: TestUser[] = [];
  for (let index = 0; index < size; index += 1) {
    const user = await makeUser(`Member ${index}`);
    await join(user.id, s.org.id, "USER");
    members.push(user);
  }
  return { ...s, members };
}

async function auditOf(
  organizationId: string,
  type: string,
  groupId?: string | null,
) {
  const rows = await prisma.platformAdministrativeAuditEvent.findMany({
    where: {
      organizationId,
      type: type as never,
      ...(groupId === undefined ? {} : { groupId }),
    },
    orderBy: [{ targetUserId: "asc" }],
  });
  return rows;
}

const flagsOf = (row: {
  readInvoices: boolean | null;
  createInvoices: boolean | null;
  deleteOwnInvoices: boolean | null;
  deleteOthersInvoices: boolean | null;
}) => ({
  readInvoices: row.readInvoices,
  createInvoices: row.createInvoices,
  deleteOwnInvoices: row.deleteOwnInvoices,
  deleteOthersInvoices: row.deleteOthersInvoices,
});

describe("CR-209 permission changes are audited", () => {
  it("writes one MEMBERSHIP_PERMISSIONS_CHANGED row for an organization single PUT", async () => {
    const s = await team(1);
    const member = s.members[0]!;

    const response = await call(
      "put",
      `/organizations/${s.org.id}/memberships/${member.id}/permissions`,
      await cookieFor(s.admin),
      { permissions: READ_CREATE },
    );
    expect(response.status).toBe(200);

    const rows = await auditOf(s.org.id, "MEMBERSHIP_PERMISSIONS_CHANGED");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: s.admin.id,
      targetUserId: member.id,
      groupId: null,
      actorIsTarget: false,
      ...READ_CREATE,
    });
  });

  it("writes one row per member for an organization bulk PUT", async () => {
    const s = await team(3);
    const ids = s.members.map((member) => member.id);

    const response = await call(
      "put",
      `/organizations/${s.org.id}/memberships/permissions`,
      await cookieFor(s.admin),
      { userIds: ids, permissions: ALL_FLAGS },
    );
    expect(response.status).toBe(200);

    const rows = await auditOf(s.org.id, "MEMBERSHIP_PERMISSIONS_CHANGED");
    expect(rows.map((row) => row.targetUserId).sort()).toEqual([...ids].sort());
    for (const row of rows) {
      expect(row.groupId).toBeNull();
      expect(row.actorUserId).toBe(s.admin.id);
      expect(flagsOf(row)).toEqual(ALL_FLAGS);
    }
  });

  it("audits the group single and bulk PUTs with the group id", async () => {
    const s = await team(3);
    for (const member of s.members) {
      await addToGroup(s.group.id, member.id, s.org.id);
    }
    const cookie = await cookieFor(s.admin);
    const base = `/organizations/${s.org.id}/groups/${s.group.id}/memberships`;

    expect(
      (
        await call("put", `${base}/${s.members[0]!.id}/permissions`, cookie, {
          permissions: READ_CREATE,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("put", `${base}/permissions`, cookie, {
          userIds: [s.members[1]!.id, s.members[2]!.id],
          permissions: ALL_FLAGS,
        })
      ).status,
    ).toBe(200);

    const rows = await auditOf(
      s.org.id,
      "MEMBERSHIP_PERMISSIONS_CHANGED",
      s.group.id,
    );
    expect(rows).toHaveLength(3);
    const byTarget = new Map(rows.map((row) => [row.targetUserId, row]));
    expect(flagsOf(byTarget.get(s.members[0]!.id)!)).toEqual(READ_CREATE);
    expect(flagsOf(byTarget.get(s.members[1]!.id)!)).toEqual(ALL_FLAGS);
    expect(flagsOf(byTarget.get(s.members[2]!.id)!)).toEqual(ALL_FLAGS);
  });

  it("audits group add (single and bulk) with the initial flags", async () => {
    const s = await team(3);
    const cookie = await cookieFor(s.admin);
    const base = `/organizations/${s.org.id}/groups/${s.group.id}/memberships`;

    expect(
      (
        await call("post", base, cookie, {
          userId: s.members[0]!.id,
          permissions: READ_CREATE,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call("post", `${base}/bulk`, cookie, {
          members: [
            { userId: s.members[1]!.id, permissions: ALL_FLAGS },
            { userId: s.members[2]!.id },
          ],
        })
      ).status,
    ).toBe(201);

    const rows = await auditOf(s.org.id, "GROUP_MEMBERSHIP_CREATED");
    expect(rows).toHaveLength(3);
    const byTarget = new Map(rows.map((row) => [row.targetUserId, row]));
    expect(flagsOf(byTarget.get(s.members[0]!.id)!)).toEqual(READ_CREATE);
    expect(flagsOf(byTarget.get(s.members[1]!.id)!)).toEqual(ALL_FLAGS);
    expect(flagsOf(byTarget.get(s.members[2]!.id)!)).toEqual(NO_FLAGS);
    for (const row of rows) expect(row.groupId).toBe(s.group.id);
  });

  it("audits a group removal and the group cascade of an organization removal", async () => {
    const s = await team(2);
    const second = await makeGroup(s.org.id, "Second");
    const [direct, cascaded] = s.members as [TestUser, TestUser];
    await addToGroup(s.group.id, direct.id, s.org.id);
    await addToGroup(s.group.id, cascaded.id, s.org.id);
    await addToGroup(second.id, cascaded.id, s.org.id);
    const cookie = await cookieFor(s.admin);

    expect(
      (
        await call(
          "delete",
          `/organizations/${s.org.id}/groups/${s.group.id}/memberships/${direct.id}`,
          cookie,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await call(
          "delete",
          `/organizations/${s.org.id}/memberships/${cascaded.id}`,
          cookie,
        )
      ).status,
    ).toBe(204);

    const removed = await auditOf(s.org.id, "GROUP_MEMBERSHIP_REMOVED");
    expect(
      removed.map((row) => `${row.targetUserId}:${row.groupId}`).sort(),
    ).toEqual(
      [
        `${direct.id}:${s.group.id}`,
        `${cascaded.id}:${s.group.id}`,
        `${cascaded.id}:${second.id}`,
      ].sort(),
    );
    const organizationRemoved = await auditOf(
      s.org.id,
      "ORGANIZATION_MEMBERSHIP_REMOVED",
    );
    expect(organizationRemoved).toHaveLength(1);
    expect(organizationRemoved[0]).toMatchObject({
      targetUserId: cascaded.id,
      actorUserId: s.admin.id,
    });
  });

  it("writes no audit row when the change fails (same transaction)", async () => {
    const s = await team(2);
    const before = await prisma.platformAdministrativeAuditEvent.count({
      where: { organizationId: s.org.id },
    });

    const response = await call(
      "put",
      `/organizations/${s.org.id}/memberships/permissions`,
      await cookieFor(s.admin),
      {
        userIds: [s.members[0]!.id, s.outsider.id],
        permissions: ALL_FLAGS,
      },
    );
    expect(response.status).toBe(404);

    expect(
      await prisma.platformAdministrativeAuditEvent.count({
        where: { organizationId: s.org.id },
      }),
    ).toBe(before);
  });

  it("rolls the change back when the audit insert fails", async () => {
    const s = await team(1);
    const member = s.members[0]!;
    await client.query(`
      CREATE OR REPLACE FUNCTION cr209_fail_audit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'audit insert refused'; END;
      $$ LANGUAGE plpgsql`);
    await client.query(`
      CREATE TRIGGER cr209_fail_audit BEFORE INSERT ON "PlatformAdministrativeAuditEvent"
      FOR EACH ROW WHEN (NEW."type" = 'MEMBERSHIP_PERMISSIONS_CHANGED')
      EXECUTE FUNCTION cr209_fail_audit()`);
    try {
      const response = await call(
        "put",
        `/organizations/${s.org.id}/memberships/${member.id}/permissions`,
        await cookieFor(s.admin),
        { permissions: ALL_FLAGS },
      );
      expect(response.status).toBe(500);
    } finally {
      await client.query(
        'DROP TRIGGER IF EXISTS cr209_fail_audit ON "PlatformAdministrativeAuditEvent"',
      );
      await client.query("DROP FUNCTION IF EXISTS cr209_fail_audit()");
    }
    const stored = await prisma.organizationMembership.findUniqueOrThrow({
      where: {
        userId_organizationId: { userId: member.id, organizationId: s.org.id },
      },
    });
    expect(stored.readInvoices).toBe(false);
  });

  it("stores identifiers and flags only (no personal data or secrets)", async () => {
    const s = await team(1);
    await call(
      "put",
      `/organizations/${s.org.id}/memberships/${s.members[0]!.id}/permissions`,
      await cookieFor(s.admin),
      { permissions: READ_CREATE },
    );
    const [row] = await auditOf(s.org.id, "MEMBERSHIP_PERMISSIONS_CHANGED");
    expect(Object.keys(row!).sort()).toEqual(
      [
        "id",
        "type",
        "actorUserId",
        "targetUserId",
        "organizationId",
        "groupId",
        "previousRole",
        "role",
        "readInvoices",
        "createInvoices",
        "deleteOwnInvoices",
        "deleteOthersInvoices",
        "actorIsTarget",
        "createdAt",
      ].sort(),
    );
    const serialized = JSON.stringify(row);
    for (const secret of [s.members[0]!.rawRut, s.admin.rawRut, "Member 0"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("CR-210 self-grant is allowed and audited", () => {
  it("lets an organization ADMIN assign permissions to themselves and flags the audit row", async () => {
    const s = await team(1);

    const response = await call(
      "put",
      `/organizations/${s.org.id}/memberships/${s.admin.id}/permissions`,
      await cookieFor(s.admin),
      { permissions: ALL_FLAGS },
    );
    expect(response.status).toBe(200);
    expect(response.body.membership.permissions).toEqual(ALL_FLAGS);

    const rows = await auditOf(s.org.id, "MEMBERSHIP_PERMISSIONS_CHANGED");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: s.admin.id,
      targetUserId: s.admin.id,
      actorIsTarget: true,
    });
  });

  it("flags only the acting member inside a bulk change", async () => {
    const s = await team(2);
    const response = await call(
      "put",
      `/organizations/${s.org.id}/memberships/permissions`,
      await cookieFor(s.admin),
      {
        userIds: [s.admin.id, ...s.members.map((member) => member.id)],
        permissions: READ_CREATE,
      },
    );
    expect(response.status).toBe(200);

    const rows = await auditOf(s.org.id, "MEMBERSHIP_PERMISSIONS_CHANGED");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.actorIsTarget).toBe(row.targetUserId === s.admin.id);
    }
  });

  it("lets the platform administrator assign permissions to their own membership (audited)", async () => {
    const s = await team(1);
    await join(platform.id, s.org.id, "USER");

    const response = await call(
      "put",
      `/organizations/${s.org.id}/memberships/${platform.id}/permissions`,
      await cookieFor(platform),
      { permissions: ALL_FLAGS },
    );
    expect(response.status).toBe(200);

    const rows = await auditOf(s.org.id, "MEMBERSHIP_PERMISSIONS_CHANGED");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: platform.id,
      targetUserId: platform.id,
      actorIsTarget: true,
    });
  });

  it("grants no implicit invoice access: platform administrator and ADMIN start with every flag false", async () => {
    const s = await team(1);
    await join(platform.id, s.org.id, "ADMIN");
    for (const userId of [s.admin.id, platform.id]) {
      const stored = await prisma.organizationMembership.findUniqueOrThrow({
        where: {
          userId_organizationId: { userId, organizationId: s.org.id },
        },
      });
      expect({
        readInvoices: stored.readInvoices,
        createInvoices: stored.createInvoices,
        deleteOwnInvoices: stored.deleteOwnInvoices,
        deleteOthersInvoices: stored.deleteOthersInvoices,
      }).toEqual(NO_FLAGS);
    }
  });
});
