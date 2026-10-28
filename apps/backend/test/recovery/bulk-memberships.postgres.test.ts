import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  ALL_FLAGS,
  membershipFixtures,
  NO_FLAGS,
  type TestUser,
} from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";
import type { Response } from "../support/request.js";

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

async function orgFlags(userId: string, organizationId: string) {
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

async function groupFlags(userId: string, groupId: string) {
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

describe("B3b-UX2 GET organization summary", () => {
  it("answers the organization and its counts to any member and to the platform administrator", async () => {
    const s = await team(2);
    const group = await makeGroup(s.org.id, "Second");
    await addToGroup(group.id, s.members[0]!.id, s.org.id);

    const asAdmin = await call(
      "get",
      `/organizations/${s.org.id}`,
      await cookieFor(s.admin),
    );
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body).toEqual({
      organization: {
        id: s.org.id,
        name: s.org.name,
        slug: s.org.slug,
        description: null,
      },
      summary: { memberCount: 4, groupCount: 2 },
    });

    const asPlatform = await call(
      "get",
      `/organizations/${s.org.id}`,
      platformCookie,
    );
    expect(asPlatform.status).toBe(200);
    expect(asPlatform.body.summary).toEqual({ memberCount: 4, groupCount: 2 });
  });

  it("counts only the own groups for a plain member", async () => {
    const s = await team(2);
    const group = await makeGroup(s.org.id, "Second");
    await addToGroup(group.id, s.members[0]!.id, s.org.id);

    const own = await call(
      "get",
      `/organizations/${s.org.id}`,
      await cookieFor(s.members[0]!),
    );
    const other = await call(
      "get",
      `/organizations/${s.org.id}`,
      await cookieFor(s.members[1]!),
    );

    expect(own.status).toBe(200);
    expect(own.body.summary).toEqual({ memberCount: 4, groupCount: 1 });
    expect(other.body.summary).toEqual({ memberCount: 4, groupCount: 0 });
  });

  it("answers 404 to a non-member and for a missing organization, and 401 without a session", async () => {
    const s = await team(1);

    const outsider = await call(
      "get",
      `/organizations/${s.org.id}`,
      await cookieFor(s.outsider),
    );
    expect(outsider.status).toBe(404);
    expect(outsider.body.error.code).toBe("NOT_FOUND");
    expect(
      (await call("get", `/organizations/${MISSING}`, await cookieFor(s.admin)))
        .status,
    ).toBe(404);
    expect(
      (await call("get", `/organizations/${MISSING}`, platformCookie)).status,
    ).toBe(404);
    expect(
      (await call("get", `/organizations/${s.org.id}`, undefined)).status,
    ).toBe(401);
  });
});

describe("B3b-UX2 PUT organization memberships permissions (bulk)", () => {
  it("replaces the flags of every listed member and answers them in request order", async () => {
    const s = await team(3);
    const [a, b, c] = s.members as [TestUser, TestUser, TestUser];
    const sent = { ...NO_FLAGS, readInvoices: true, createInvoices: true };

    const response = await call(
      "put",
      `/organizations/${s.org.id}/memberships/permissions`,
      await cookieFor(s.admin),
      { userIds: [c.id, a.id], permissions: sent },
    );

    expect(response.status).toBe(200);
    expect(response.body.memberships).toEqual([
      {
        userId: c.id,
        organizationId: s.org.id,
        role: "USER",
        permissions: sent,
      },
      {
        userId: a.id,
        organizationId: s.org.id,
        role: "USER",
        permissions: sent,
      },
    ]);
    expect(await orgFlags(a.id, s.org.id)).toEqual(sent);
    expect(await orgFlags(c.id, s.org.id)).toEqual(sent);
    expect(await orgFlags(b.id, s.org.id)).toEqual(NO_FLAGS);
  });

  it("allows an organization ADMIN and the platform administrator, and nobody else", async () => {
    const s = await team(1);
    const path = `/organizations/${s.org.id}/memberships/permissions`;
    const body = { userIds: [s.members[0]!.id], permissions: ALL_FLAGS };

    expect(
      (await call("put", path, await cookieFor(s.members[0]!), body)).status,
    ).toBe(403);
    expect(
      (await call("put", path, await cookieFor(s.outsider), body)).status,
    ).toBe(404);
    expect(await orgFlags(s.members[0]!.id, s.org.id)).toEqual(NO_FLAGS);
    expect(
      (await call("put", path, await cookieFor(s.admin), body)).status,
    ).toBe(200);
    expect((await call("put", path, platformCookie, body)).status).toBe(200);
  });

  it("answers 404 and persists nothing when any listed user is not a member", async () => {
    const s = await team(2);
    const path = `/organizations/${s.org.id}/memberships/permissions`;

    const response = await call("put", path, await cookieFor(s.admin), {
      userIds: [s.members[0]!.id, s.outsider.id, s.members[1]!.id],
      permissions: ALL_FLAGS,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(await orgFlags(s.members[0]!.id, s.org.id)).toEqual(NO_FLAGS);
    expect(await orgFlags(s.members[1]!.id, s.org.id)).toEqual(NO_FLAGS);
  });

  it("answers 404 for a foreign organization ADMIN and a missing organization", async () => {
    const s = await team(1);
    const otherOrg = await makeOrg("other");
    const otherAdmin = await makeUser();
    await join(otherAdmin.id, otherOrg.id, "ADMIN");
    const body = { userIds: [s.members[0]!.id], permissions: ALL_FLAGS };

    expect(
      (
        await call(
          "put",
          `/organizations/${s.org.id}/memberships/permissions`,
          await cookieFor(otherAdmin),
          body,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          "put",
          `/organizations/${MISSING}/memberships/permissions`,
          platformCookie,
          body,
        )
      ).status,
    ).toBe(404);
    expect(await orgFlags(s.members[0]!.id, s.org.id)).toEqual(NO_FLAGS);
  });

  it.each([
    ["an empty userIds", () => ({ userIds: [], permissions: NO_FLAGS })],
    [
      "duplicate userIds",
      (id: string) => ({ userIds: [id, id], permissions: NO_FLAGS }),
    ],
    [
      "a non-UUID user id",
      () => ({ userIds: ["not-a-uuid"], permissions: NO_FLAGS }),
    ],
    [
      "more than 200 user ids",
      () => ({
        userIds: Array.from({ length: 201 }, () => crypto.randomUUID()),
        permissions: NO_FLAGS,
      }),
    ],
    ["a missing permissions object", (id: string) => ({ userIds: [id] })],
    [
      "a partial permissions object",
      (id: string) => ({ userIds: [id], permissions: { readInvoices: true } }),
    ],
    [
      "an unknown top-level field",
      (id: string) => ({ userIds: [id], permissions: NO_FLAGS, role: "ADMIN" }),
    ],
  ])("rejects %s with 400 and persists nothing", async (_label, build) => {
    const s = await team(1);
    const member = s.members[0]!;

    const response = await call(
      "put",
      `/organizations/${s.org.id}/memberships/permissions`,
      await cookieFor(s.admin),
      build(member.id),
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(await orgFlags(member.id, s.org.id)).toEqual(NO_FLAGS);
  });

  it("accepts exactly 200 user ids shape-wise (all or nothing 404 for unknown members)", async () => {
    const s = await team(1);
    const response = await call(
      "put",
      `/organizations/${s.org.id}/memberships/permissions`,
      await cookieFor(s.admin),
      {
        userIds: Array.from({ length: 200 }, () => crypto.randomUUID()),
        permissions: NO_FLAGS,
      },
    );
    expect(response.status).toBe(404);
  });
});

describe("B3b-UX2 PUT group memberships permissions (bulk)", () => {
  async function groupTeam() {
    const s = await team(3);
    for (const member of s.members) {
      await addToGroup(s.group.id, member.id, s.org.id);
    }
    return s;
  }
  const path = (s: { org: { id: string }; group: { id: string } }) =>
    `/organizations/${s.org.id}/groups/${s.group.id}/memberships`;

  it("replaces the flags of every listed member and leaves the others alone", async () => {
    const s = await groupTeam();
    const [a, b, c] = s.members as [TestUser, TestUser, TestUser];
    const sent = { ...NO_FLAGS, deleteOwnInvoices: true };

    const response = await call(
      "put",
      `${path(s)}/permissions`,
      await cookieFor(s.admin),
      { userIds: [b.id, a.id], permissions: sent },
    );

    expect(response.status).toBe(200);
    expect(response.body.memberships).toEqual([
      {
        userId: b.id,
        groupId: s.group.id,
        organizationId: s.org.id,
        permissions: sent,
      },
      {
        userId: a.id,
        groupId: s.group.id,
        organizationId: s.org.id,
        permissions: sent,
      },
    ]);
    expect(await groupFlags(c.id, s.group.id)).toEqual(NO_FLAGS);
    expect(await orgFlags(a.id, s.org.id)).toEqual(NO_FLAGS);
  });

  it("allows an organization ADMIN and the platform administrator, and nobody else", async () => {
    const s = await groupTeam();
    const body = { userIds: [s.members[0]!.id], permissions: ALL_FLAGS };

    expect(
      (
        await call(
          "put",
          `${path(s)}/permissions`,
          await cookieFor(s.members[0]!),
          body,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "put",
          `${path(s)}/permissions`,
          await cookieFor(s.outsider),
          body,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          "put",
          `${path(s)}/permissions`,
          await cookieFor(s.admin),
          body,
        )
      ).status,
    ).toBe(200);
    expect(
      (await call("put", `${path(s)}/permissions`, platformCookie, body))
        .status,
    ).toBe(200);
  });

  it("answers 404 and persists nothing when a listed user is not in the group, or the group is foreign", async () => {
    const s = await groupTeam();
    const notInGroup = await makeUser();
    await join(notInGroup.id, s.org.id, "USER");

    const partial = await call(
      "put",
      `${path(s)}/permissions`,
      await cookieFor(s.admin),
      {
        userIds: [s.members[0]!.id, notInGroup.id],
        permissions: ALL_FLAGS,
      },
    );
    expect(partial.status).toBe(404);
    expect(await groupFlags(s.members[0]!.id, s.group.id)).toEqual(NO_FLAGS);

    const otherOrg = await makeOrg("foreign");
    const foreignGroup = await makeGroup(otherOrg.id, "Foreign");
    const foreign = await call(
      "put",
      `/organizations/${s.org.id}/groups/${foreignGroup.id}/memberships/permissions`,
      await cookieFor(s.admin),
      { userIds: [s.members[0]!.id], permissions: ALL_FLAGS },
    );
    expect(foreign.status).toBe(404);
  });

  it("rejects invalid bodies with 400 and persists nothing", async () => {
    const s = await groupTeam();
    const cookie = await cookieFor(s.admin);
    const id = s.members[0]!.id;
    for (const body of [
      { userIds: [], permissions: ALL_FLAGS },
      { userIds: [id, id], permissions: ALL_FLAGS },
      { userIds: [id], permissions: { readInvoices: true } },
      { userIds: [id], permissions: ALL_FLAGS, extra: 1 },
    ]) {
      const response = await call(
        "put",
        `${path(s)}/permissions`,
        cookie,
        body,
      );
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(await groupFlags(id, s.group.id)).toEqual(NO_FLAGS);
  });
});

describe("B3b-UX2 POST group memberships bulk", () => {
  const path = (s: { org: { id: string }; group: { id: string } }) =>
    `/organizations/${s.org.id}/groups/${s.group.id}/memberships/bulk`;

  it("adds every member with its own permissions atomically and answers them in request order", async () => {
    const s = await team(3);
    const [a, b, c] = s.members as [TestUser, TestUser, TestUser];
    const readOnly = { ...NO_FLAGS, readInvoices: true };

    const response = await call("post", path(s), await cookieFor(s.admin), {
      members: [
        { userId: c.id, permissions: ALL_FLAGS },
        { userId: a.id, permissions: readOnly },
        { userId: b.id },
      ],
    });

    expect(response.status).toBe(201);
    expect(response.body.memberships).toEqual([
      {
        userId: c.id,
        groupId: s.group.id,
        organizationId: s.org.id,
        permissions: ALL_FLAGS,
      },
      {
        userId: a.id,
        groupId: s.group.id,
        organizationId: s.org.id,
        permissions: readOnly,
      },
      {
        userId: b.id,
        groupId: s.group.id,
        organizationId: s.org.id,
        permissions: NO_FLAGS,
      },
    ]);
    expect(await groupFlags(c.id, s.group.id)).toEqual(ALL_FLAGS);
    expect(await groupFlags(a.id, s.group.id)).toEqual(readOnly);
  });

  it("allows an organization ADMIN and the platform administrator, and nobody else", async () => {
    const s = await team(2);
    const [a, b] = s.members as [TestUser, TestUser];

    expect(
      (
        await call("post", path(s), await cookieFor(a), {
          members: [{ userId: a.id }],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("post", path(s), await cookieFor(s.outsider), {
          members: [{ userId: a.id }],
        })
      ).status,
    ).toBe(404);
    expect(
      await prisma.groupMembership.count({ where: { groupId: s.group.id } }),
    ).toBe(0);
    expect(
      (
        await call("post", path(s), platformCookie, {
          members: [{ userId: b.id }],
        })
      ).status,
    ).toBe(201);
  });

  it("accepts 200 members with their own permissions (a body above 16 kB) and rejects 201 with 400", async () => {
    const s = await team(0);
    const users = Array.from({ length: 201 }, (_unused, index) => ({
      id: crypto.randomUUID(),
      name: `Bulk ${index}`,
      rut: `bulk-${crypto.randomUUID()}`,
    }));
    await prisma.user.createMany({ data: users });
    await prisma.organizationMembership.createMany({
      data: users.map((user) => ({
        userId: user.id,
        organizationId: s.org.id,
        role: "USER" as const,
      })),
    });
    const cookie = await cookieFor(s.admin);
    const toMember = (user: { id: string }) => ({
      userId: user.id,
      permissions: ALL_FLAGS,
    });
    const body200 = { members: users.slice(0, 200).map(toMember) };
    expect(JSON.stringify(body200).length).toBeGreaterThan(16 * 1024);

    const tooMany = await call("post", path(s), cookie, {
      members: users.map(toMember),
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe("VALIDATION_ERROR");
    expect(
      await prisma.groupMembership.count({ where: { groupId: s.group.id } }),
    ).toBe(0);

    const ok = await call("post", path(s), cookie, body200);
    expect(ok.status).toBe(201);
    expect(ok.body.memberships).toHaveLength(200);
    expect(
      await prisma.groupMembership.count({ where: { groupId: s.group.id } }),
    ).toBe(200);
    // One audit row per member, written with the batch.
    expect(
      await prisma.platformAdministrativeAuditEvent.count({
        where: {
          organizationId: s.org.id,
          type: "GROUP_MEMBERSHIP_CREATED",
        },
      }),
    ).toBe(200);
  });

  it("answers 409 ORGANIZATION_MEMBERSHIP_REQUIRED and persists nothing when a user is not an organization member", async () => {
    const s = await team(2);

    const response = await call("post", path(s), await cookieFor(s.admin), {
      members: [{ userId: s.members[0]!.id }, { userId: s.outsider.id }],
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ORGANIZATION_MEMBERSHIP_REQUIRED");
    expect(
      await prisma.groupMembership.count({ where: { groupId: s.group.id } }),
    ).toBe(0);
  });

  it("answers 409 MEMBERSHIP_CONFLICT and persists nothing when one user is already in the group", async () => {
    const s = await team(2);
    await addToGroup(s.group.id, s.members[1]!.id, s.org.id);

    const response = await call("post", path(s), await cookieFor(s.admin), {
      members: [{ userId: s.members[0]!.id }, { userId: s.members[1]!.id }],
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("MEMBERSHIP_CONFLICT");
    expect(
      await prisma.groupMembership.count({ where: { groupId: s.group.id } }),
    ).toBe(1);
  });

  it("answers 404 for a group of another organization and 400 for invalid bodies", async () => {
    const s = await team(1);
    const cookie = await cookieFor(s.admin);
    const otherOrg = await makeOrg("foreign");
    const foreignGroup = await makeGroup(otherOrg.id, "Foreign");
    const id = s.members[0]!.id;

    expect(
      (
        await call(
          "post",
          `/organizations/${s.org.id}/groups/${foreignGroup.id}/memberships/bulk`,
          cookie,
          { members: [{ userId: id }] },
        )
      ).status,
    ).toBe(404);

    for (const body of [
      { members: [] },
      { members: [{ userId: id }, { userId: id }] },
      { members: [{ userId: "nope" }] },
      { members: [{ userId: id, permissions: { readInvoices: true } }] },
      { members: [{ userId: id, role: "ADMIN" }] },
      { members: [{ userId: id }], extra: true },
    ]) {
      const response = await call("post", path(s), cookie, body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(
      await prisma.groupMembership.count({ where: { groupId: s.group.id } }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrency. Operations run SERIALIZABLE and lose races with a retryable
// 503 when their bounded in-process retries are exhausted; the client contract
// is to repeat the request. Every race below therefore:
//   - runs on its own connection pool (so its backends flush their statistics
//     when it is closed) and requires pg_stat_database.deadlocks unchanged;
//   - settles each request like a client would (repeat on 503, bounded) and
//     asserts every request reached its terminal status;
//   - asserts the final state equals one of the serializable outcomes, never
//     a mix.
// ---------------------------------------------------------------------------

async function deadlockCount() {
  const result = await client.query(
    "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()",
  );
  return Number(result.rows[0]!.deadlocks);
}

/**
 * Runs `load` against an app with a dedicated, named pool. Closing the pool
 * makes its backends exit and flush their statistics before they disappear
 * from pg_stat_activity, so the deadlock counter read afterwards includes
 * every deadlock the load caused.
 */
async function withRace<T>(
  load: (race: typeof call, applicationName: string) => Promise<T>,
): Promise<T> {
  const before = await deadlockCount();
  const applicationName = `race-${randomUUID()}`;
  const racePrisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url,
      application_name: applicationName,
    }),
  });
  const raceApp = createApp(
    { isReady: async () => true, prisma: racePrisma },
    auth,
  );
  const race = membershipFixtures({
    prisma: racePrisma,
    client,
    auth,
    app: raceApp,
    url,
  }).call;
  let result: T;
  try {
    result = await load(race, applicationName);
  } finally {
    await racePrisma.$disconnect();
  }
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const open = await client.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name = $1",
      [applicationName],
    );
    if (!open.rowCount) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(await deadlockCount()).toBe(before);
  return result;
}

const MAX_CLIENT_ATTEMPTS = 12;

/**
 * Sends like a client honoring the 503 contract: repeat while the answer is
 * RETRYABLE_CONFLICT (bounded). Returns the terminal response and how many
 * times the request was repeated.
 */
async function settled(send: () => PromiseLike<Response>) {
  for (let attempt = 0; attempt < MAX_CLIENT_ATTEMPTS; attempt += 1) {
    const response = await send();
    if (response.status !== 503) return { response, repeats: attempt };
    expect(response.body.error.code).toBe("RETRYABLE_CONFLICT");
    expect(response.headers["retry-after"]).toBe("1");
  }
  throw new Error("request still conflicted after the bounded client retries");
}

const isUniform = (flags: Record<string, boolean>) =>
  new Set(Object.values(flags)).size === 1;

/**
 * Proves the requests overlap instead of hoping the scheduler made them. Every
 * operation of these races takes a lock on the organization's membership rows
 * first, so the test holds those rows FOR UPDATE, only then starts all the requests,
 * waits until every one of them is blocked on that lock in a backend of its
 * own (all in flight at once), and only then lets go. From that point they
 * contend for the same rows. A bounded wait that fails means a request never
 * reached the lock, which is a failure of the test, not a flake to retry.
 */
async function overlapped<T>(
  organizationId: string,
  applicationName: string,
  startRequests: () => ReadonlyArray<PromiseLike<T>>,
): Promise<T[]> {
  const holder = new pg.Client({ connectionString: url });
  await holder.connect();
  let running: Array<PromiseLike<T>> = [];
  try {
    await holder.query("BEGIN");
    await holder.query(
      'SELECT id FROM "OrganizationMembership" WHERE "organizationId" = $1 FOR UPDATE',
      [organizationId],
    );
    running = [...startRequests()];
    let blocked = 0;
    for (
      let attempt = 0;
      attempt < 200 && blocked < running.length;
      attempt += 1
    ) {
      const result = await client.query(
        `SELECT count(*)::int AS blocked FROM pg_stat_activity
         WHERE application_name = $1 AND wait_event_type = 'Lock'`,
        [applicationName],
      );
      blocked = Number(result.rows[0]!.blocked);
      if (blocked < running.length)
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(blocked).toBeGreaterThanOrEqual(running.length);
    await holder.query("COMMIT");
  } finally {
    // Ends the holder's transaction if the wait failed, so nothing stays blocked.
    await holder.end();
    await Promise.allSettled(running);
  }
  return Promise.all(running);
}

describe("CR-212 bulk operations under contention", () => {
  // Each round builds a fresh team (password hashing dominates the cost).
  const ROUNDS = 4;
  const REMOVAL_ROUNDS = 6;

  it("two bulk organization PUTs in opposite order end in one outcome for every member", async () => {
    await withRace(async (race, applicationName) => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const s = await team(4);
        const ids = s.members.map((member) => member.id);
        const cookie = await cookieFor(s.admin);
        const path = `/organizations/${s.org.id}/memberships/permissions`;

        const results = await overlapped(s.org.id, applicationName, () => [
          settled(() =>
            race("put", path, cookie, { userIds: ids, permissions: ALL_FLAGS }),
          ),
          settled(() =>
            race("put", path, cookie, {
              userIds: [...ids].reverse(),
              permissions: NO_FLAGS,
            }),
          ),
        ]);

        for (const { response } of results) expect(response.status).toBe(200);
        // Whichever committed last wins for everybody: never a mix.
        const finals = await Promise.all(
          ids.map((id) => orgFlags(id, s.org.id)),
        );
        expect([ALL_FLAGS, NO_FLAGS]).toContainEqual(finals[0]);
        for (const flags of finals) expect(flags).toEqual(finals[0]);
      }
    });
  });

  it("a bulk organization PUT racing single PUTs leaves every row with one coherent flag set", async () => {
    await withRace(async (race, applicationName) => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const s = await team(4);
        const ids = s.members.map((member) => member.id);
        const cookie = await cookieFor(s.admin);
        const path = `/organizations/${s.org.id}/memberships`;

        const results = await overlapped(s.org.id, applicationName, () => [
          settled(() =>
            race("put", `${path}/permissions`, cookie, {
              userIds: ids,
              permissions: ALL_FLAGS,
            }),
          ),
          settled(() =>
            race("put", `${path}/permissions`, cookie, {
              userIds: [...ids].reverse(),
              permissions: NO_FLAGS,
            }),
          ),
          ...ids.map((id, index) =>
            settled(() =>
              race("put", `${path}/${id}/permissions`, cookie, {
                permissions: index % 2 ? ALL_FLAGS : NO_FLAGS,
              }),
            ),
          ),
        ]);

        for (const { response } of results) expect(response.status).toBe(200);
        // Every PUT writes all-true or all-false: a row that is not uniform
        // would be a half-applied write.
        for (const id of ids) {
          expect(isUniform(await orgFlags(id, s.org.id))).toBe(true);
        }
      }
    });
  });

  it("two bulk group PUTs in opposite order end in one outcome for every member", async () => {
    await withRace(async (race, applicationName) => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const s = await team(4);
        const ids = s.members.map((member) => member.id);
        for (const id of ids) await addToGroup(s.group.id, id, s.org.id);
        const cookie = await cookieFor(s.admin);
        const path = `/organizations/${s.org.id}/groups/${s.group.id}/memberships/permissions`;

        const results = await overlapped(s.org.id, applicationName, () => [
          settled(() =>
            race("put", path, cookie, { userIds: ids, permissions: ALL_FLAGS }),
          ),
          settled(() =>
            race("put", path, cookie, {
              userIds: [...ids].reverse(),
              permissions: NO_FLAGS,
            }),
          ),
        ]);

        for (const { response } of results) expect(response.status).toBe(200);
        const finals = await Promise.all(
          ids.map((id) => groupFlags(id, s.group.id)),
        );
        expect([ALL_FLAGS, NO_FLAGS]).toContainEqual(finals[0]);
        for (const flags of finals) expect(flags).toEqual(finals[0]);
      }
    });
  });

  it("a bulk group PUT racing single group PUTs leaves every row coherent", async () => {
    await withRace(async (race, applicationName) => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const s = await team(4);
        const ids = s.members.map((member) => member.id);
        for (const id of ids) await addToGroup(s.group.id, id, s.org.id);
        const cookie = await cookieFor(s.admin);
        const path = `/organizations/${s.org.id}/groups/${s.group.id}/memberships`;

        const results = await overlapped(s.org.id, applicationName, () => [
          settled(() =>
            race("put", `${path}/permissions`, cookie, {
              userIds: ids,
              permissions: ALL_FLAGS,
            }),
          ),
          settled(() =>
            race("put", `${path}/permissions`, cookie, {
              userIds: [...ids].reverse(),
              permissions: NO_FLAGS,
            }),
          ),
          ...ids.map((id, index) =>
            settled(() =>
              race("put", `${path}/${id}/permissions`, cookie, {
                permissions: index % 2 ? ALL_FLAGS : NO_FLAGS,
              }),
            ),
          ),
        ]);

        for (const { response } of results) expect(response.status).toBe(200);
        for (const id of ids) {
          expect(isUniform(await groupFlags(id, s.group.id))).toBe(true);
        }
      }
    });
  });

  it("a bulk organization PUT racing the removal of one target applies entirely or not at all", async () => {
    await withRace(async (race, applicationName) => {
      for (let round = 0; round < REMOVAL_ROUNDS; round += 1) {
        const s = await team(3);
        const [removed, ...kept] = s.members as [TestUser, TestUser, TestUser];
        await addToGroup(s.group.id, removed.id, s.org.id);
        const cookie = await cookieFor(s.admin);

        const [bulk, removal] = await overlapped(
          s.org.id,
          applicationName,
          () => [
            settled(() =>
              race(
                "put",
                `/organizations/${s.org.id}/memberships/permissions`,
                cookie,
                {
                  userIds: [removed.id, ...kept.map((member) => member.id)],
                  permissions: ALL_FLAGS,
                },
              ),
            ),
            settled(() =>
              race(
                "delete",
                `/organizations/${s.org.id}/memberships/${removed.id}`,
                cookie,
              ),
            ),
          ],
        );

        expect(removal.response.status).toBe(204);
        // The removal cascades the group membership in every outcome.
        expect(
          await prisma.groupMembership.count({
            where: { userId: removed.id, organizationId: s.org.id },
          }),
        ).toBe(0);
        expect(
          await prisma.organizationMembership.count({
            where: { userId: removed.id, organizationId: s.org.id },
          }),
        ).toBe(0);
        if (bulk.response.status === 200) {
          // Applied to everyone, including the member removed right after.
          for (const member of kept) {
            expect(await orgFlags(member.id, s.org.id)).toEqual(ALL_FLAGS);
          }
        } else {
          expect(bulk.response.status).toBe(404);
          // All or nothing: the surviving targets were not touched.
          for (const member of kept) {
            expect(await orgFlags(member.id, s.org.id)).toEqual(NO_FLAGS);
          }
        }
      }
    });
  });

  it("a bulk group add racing the organization removal of one target adds all or none, never an orphan", async () => {
    await withRace(async (race, applicationName) => {
      for (let round = 0; round < REMOVAL_ROUNDS; round += 1) {
        const s = await team(3);
        const [removed, ...kept] = s.members as [TestUser, TestUser, TestUser];
        const cookie = await cookieFor(s.admin);

        const [bulk, removal] = await overlapped(
          s.org.id,
          applicationName,
          () => [
            settled(() =>
              race(
                "post",
                `/organizations/${s.org.id}/groups/${s.group.id}/memberships/bulk`,
                cookie,
                {
                  members: [removed, ...kept].map((member) => ({
                    userId: member.id,
                    permissions: ALL_FLAGS,
                  })),
                },
              ),
            ),
            settled(() =>
              race(
                "delete",
                `/organizations/${s.org.id}/memberships/${removed.id}`,
                cookie,
              ),
            ),
          ],
        );

        expect(removal.response.status).toBe(204);
        // The removed member never keeps a group membership (no orphan row).
        expect(
          await prisma.groupMembership.count({
            where: { userId: removed.id, organizationId: s.org.id },
          }),
        ).toBe(0);
        const inGroup = await prisma.groupMembership.count({
          where: { groupId: s.group.id },
        });
        if (bulk.response.status === 201) {
          // Added first, then cascaded away with the organization removal.
          expect(inGroup).toBe(kept.length);
        } else {
          expect(bulk.response.status).toBe(409);
          expect(bulk.response.body.error.code).toBe(
            "ORGANIZATION_MEMBERSHIP_REQUIRED",
          );
          // Nothing of the batch persisted.
          expect(inGroup).toBe(0);
        }
      }
    });
  });
});
