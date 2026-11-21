import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { membershipFixtures } from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

// CR-510: a permissions PUT that omits deployModels leaves it unchanged.
const url = recoveryTestDatabaseUrl();
const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const app = createApp(database, auth);
const f = membershipFixtures({ prisma, client, auth, app, url });

beforeAll(async () => {
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

const FOUR = {
  readInvoices: true,
  createInvoices: true,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};

/** An org ADMIN, two members of the organization and of its group, with deployModels already ON. */
async function world() {
  const s = await f.scenario();
  const second = await f.makeUser("Second");
  await f.join(second.id, s.org.id, "USER", { deployModels: true });
  await prisma.organizationMembership.update({
    where: {
      userId_organizationId: { userId: s.member.id, organizationId: s.org.id },
    },
    data: { deployModels: true },
  });
  for (const user of [s.member, second]) {
    await f.addToGroup(s.group.id, user.id, s.org.id, { deployModels: true });
  }
  return { ...s, second, adminCookie: await f.cookieFor(s.admin) };
}
type World = Awaited<ReturnType<typeof world>>;

const orgFlag = async (s: World, userId: string) =>
  (
    await prisma.organizationMembership.findUniqueOrThrow({
      where: { userId_organizationId: { userId, organizationId: s.org.id } },
    })
  ).deployModels;
const groupFlag = async (s: World, userId: string) =>
  (
    await prisma.groupMembership.findUniqueOrThrow({
      where: { groupId_userId: { groupId: s.group.id, userId } },
    })
  ).deployModels;
const latestAudit = (s: World, userId: string, groupId: string | null) =>
  prisma.platformAdministrativeAuditEvent.findFirstOrThrow({
    where: {
      type: "MEMBERSHIP_PERMISSIONS_CHANGED",
      targetUserId: userId,
      organizationId: s.org.id,
      groupId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

describe("PUT permissions without deployModels keeps it (CR-510)", () => {
  it("organization, single: unchanged when omitted, changed when explicit", async () => {
    const s = await world();
    const path = `/organizations/${s.org.id}/memberships/${s.member.id}/permissions`;

    const omitted = await f.call("put", path, s.adminCookie, {
      permissions: { ...FOUR, readInvoices: false },
    });
    expect(omitted.status).toBe(200);
    expect(omitted.body.membership.permissions).toMatchObject({
      readInvoices: false,
      deployModels: true,
    });
    expect(await orgFlag(s, s.member.id)).toBe(true);
    // The audit row carries the effective (unchanged) value, not null.
    expect((await latestAudit(s, s.member.id, null)).deployModels).toBe(true);

    const explicit = await f.call("put", path, s.adminCookie, {
      permissions: { ...FOUR, deployModels: false },
    });
    expect(explicit.body.membership.permissions.deployModels).toBe(false);
    expect(await orgFlag(s, s.member.id)).toBe(false);
    expect((await latestAudit(s, s.member.id, null)).deployModels).toBe(false);

    // Omitted again: stays false (it is not reset to anything, it is kept).
    await f.call("put", path, s.adminCookie, { permissions: FOUR });
    expect(await orgFlag(s, s.member.id)).toBe(false);
  });

  it("organization, bulk: every listed member keeps its own value", async () => {
    const s = await world();
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: s.second.id,
          organizationId: s.org.id,
        },
      },
      data: { deployModels: false },
    });

    const response = await f.call(
      "put",
      `/organizations/${s.org.id}/memberships/permissions`,
      s.adminCookie,
      { userIds: [s.member.id, s.second.id], permissions: FOUR },
    );

    expect(response.status).toBe(200);
    expect(await orgFlag(s, s.member.id)).toBe(true);
    expect(await orgFlag(s, s.second.id)).toBe(false);
    expect((await latestAudit(s, s.member.id, null)).deployModels).toBe(true);
    expect((await latestAudit(s, s.second.id, null)).deployModels).toBe(false);
  });

  it("group, single: unchanged when omitted, changed when explicit", async () => {
    const s = await world();
    const path = `/organizations/${s.org.id}/groups/${s.group.id}/memberships/${s.member.id}/permissions`;

    const omitted = await f.call("put", path, s.adminCookie, {
      permissions: FOUR,
    });
    expect(omitted.status).toBe(200);
    expect(omitted.body.membership.permissions.deployModels).toBe(true);
    expect(await groupFlag(s, s.member.id)).toBe(true);
    expect((await latestAudit(s, s.member.id, s.group.id)).deployModels).toBe(
      true,
    );

    await f.call("put", path, s.adminCookie, {
      permissions: { ...FOUR, deployModels: false },
    });
    expect(await groupFlag(s, s.member.id)).toBe(false);
  });

  it("group, bulk: every listed member keeps its own value", async () => {
    const s = await world();
    await prisma.groupMembership.update({
      where: { groupId_userId: { groupId: s.group.id, userId: s.second.id } },
      data: { deployModels: false },
    });

    const response = await f.call(
      "put",
      `/organizations/${s.org.id}/groups/${s.group.id}/memberships/permissions`,
      s.adminCookie,
      { userIds: [s.member.id, s.second.id], permissions: FOUR },
    );

    expect(response.status).toBe(200);
    expect(await groupFlag(s, s.member.id)).toBe(true);
    expect(await groupFlag(s, s.second.id)).toBe(false);
    expect((await latestAudit(s, s.second.id, s.group.id)).deployModels).toBe(
      false,
    );
  });

  it("creating a membership without the flag still means false", async () => {
    const s = await world();
    const user = await f.makeUser("Created");
    const created = await f.call(
      "post",
      `/organizations/${s.org.id}/memberships`,
      s.adminCookie,
      { rut: user.rut, role: "USER", permissions: FOUR },
    );
    expect(created.status).toBe(201);
    expect(created.body.membership.permissions.deployModels).toBe(false);
  });
});
