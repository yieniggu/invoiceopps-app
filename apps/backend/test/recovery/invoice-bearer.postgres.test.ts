import { randomUUID } from "node:crypto";

import pg, { type Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { formatRut } from "../../src/rut.js";
import {
  DAY_MS,
  bearerCall,
  seedApiToken,
  type ApiScope,
  type SeedTokenOptions,
} from "./api-token-fixtures.js";
import {
  ALL_FLAGS,
  membershipFixtures,
  NO_FLAGS,
  PASSWORD,
  randomRut,
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
const READ_CREATE: ApiScope[] = ["invoices:read", "invoices:create"];

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

const newKey = () => `key-${randomUUID()}`;

function payload(s: Scenario, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: s.org.id,
    businessId: `FAC-${randomUUID()}`,
    supplierName: "Proveedor local",
    amountPesos: 12500,
    currency: "CLP",
    issuedOn: "2026-10-25",
    dueOn: "2026-11-25",
    businessStatus: "PENDING",
    ...overrides,
  };
}

const bearerCreate = (
  secret: string,
  body: unknown,
  key: string | null = newKey(),
) => {
  const test = bearerCall(app, "post", "/invoices", secret, body);
  return key === null ? test : test.set("Idempotency-Key", key);
};

const scopeQuery = (s: Scenario, groupId?: string | null) => {
  const query = new URLSearchParams({ organizationId: s.org.id });
  if (groupId) query.set("groupId", groupId);
  return query.toString();
};
const bearerList = (secret: string, s: Scenario, groupId?: string | null) =>
  bearerCall(app, "get", `/invoices?${scopeQuery(s, groupId)}`, secret);
const bearerDetail = (
  secret: string,
  s: Scenario,
  id: string,
  groupId?: string | null,
) =>
  bearerCall(app, "get", `/invoices/${id}?${scopeQuery(s, groupId)}`, secret);
const bearerRemove = (
  secret: string,
  s: Scenario,
  id: string,
  groupId?: string | null,
) =>
  bearerCall(
    app,
    "delete",
    `/invoices/${id}?${scopeQuery(s, groupId)}`,
    secret,
  );

/** Inserts an invoice row directly; Bearer reads and deletes never need create. */
async function seed(
  organizationId: string,
  createdByUserId: string,
  groupId: string | null = null,
) {
  return prisma.invoice.create({
    data: {
      organizationId,
      groupId,
      scopeKey: groupId ?? "organization",
      businessId: `FAC-${randomUUID()}`,
      supplierName: "Proveedor local",
      amountPesos: 12500,
      currency: "CLP",
      issuedOn: new Date("2026-01-15T00:00:00.000Z"),
      dueOn: new Date("2027-01-15T00:00:00.000Z"),
      businessStatus: "PENDING",
      createdByUserId,
    },
  });
}

const invoiceCount = (organizationId: string) =>
  prisma.invoice.count({ where: { organizationId } });
const stored = (id: string) =>
  prisma.invoice.findUniqueOrThrow({ where: { id } });
const orgFlagsPath = (s: Scenario, userId: string) =>
  `/organizations/${s.org.id}/memberships/${userId}/permissions`;
const membershipPath = (s: Scenario, userId: string) =>
  `/organizations/${s.org.id}/memberships/${userId}`;

/** A member with the given organization flags and a token seeded for them. */
async function world(
  flags: Partial<typeof ALL_FLAGS> = ALL_FLAGS,
  token: Partial<Omit<SeedTokenOptions, "userId" | "organizationId">> & {
    onGroup?: boolean;
  } = {},
) {
  const s = await scenario();
  await prisma.organizationMembership.update({
    where: {
      userId_organizationId: { userId: s.member.id, organizationId: s.org.id },
    },
    data: { ...NO_FLAGS, ...flags },
  });
  const { onGroup, ...rest } = token;
  const issued = await seedApiToken(prisma, {
    userId: s.member.id,
    organizationId: s.org.id,
    groupId: onGroup ? s.group.id : null,
    ...rest,
  });
  return { s, ...issued, cookie: await cookieFor(s.member) };
}

describe("RP0-16 Bearer on the four invoice operations (AC-08)", () => {
  it("creates, lists, reads and deletes with Bearer alone and no Origin", async () => {
    const { s, secret } = await world();

    const created = await bearerCreate(secret, payload(s));
    expect(created.status).toBe(201);
    const id = created.body.invoice.id as string;
    expect(created.body.invoice.createdByUserId).toBe(s.member.id);

    const listed = await bearerList(secret, s);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toContain(
      id,
    );
    expect((await bearerDetail(secret, s, id)).status).toBe(200);
    expect((await bearerRemove(secret, s, id)).status).toBe(204);
    expect((await stored(id)).deletedAt).toBeInstanceOf(Date);
  });

  it.each([
    ["get", "/auth/profile"],
    ["post", "/auth/logout"],
    ["post", "/auth/change-password"],
    ["get", "/organizations"],
    ["get", "/admin/users"],
    ["post", "/admin/users"],
  ] as const)("answers 401 to Bearer on %s %s", async (method, path) => {
    const { secret } = await world();

    const response = await bearerCall(app, method, path, secret, {});

    expect(response.status).toBe(401);
  });

  it("answers 401 to Bearer on organization administration", async () => {
    const { s, secret } = await world();

    const response = await bearerCall(
      app,
      "put",
      orgFlagsPath(s, s.member.id),
      secret,
      { permissions: ALL_FLAGS },
    );

    expect(response.status).toBe(401);
  });

  it("answers 400 AMBIGUOUS_AUTH to Bearer plus the session cookie", async () => {
    const { s, secret, cookie } = await world();

    const response = await call("post", "/invoices", cookie, payload(s))
      .set("Authorization", `Bearer ${secret}`)
      .set("Idempotency-Key", newKey());

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("AMBIGUOUS_AUTH");
    expect(await invoiceCount(s.org.id)).toBe(0);
  });

  it("keeps validation, idempotency-key and conflict rules on Bearer writes", async () => {
    const { s, secret } = await world();

    expect((await bearerCreate(secret, payload(s), null)).status).toBe(400);
    expect(
      (await bearerCreate(secret, payload(s, { amountPesos: 0 }))).status,
    ).toBe(400);
    expect(await invoiceCount(s.org.id)).toBe(0);
  });
});

describe("RP0-16 token credential errors (SUP-2)", () => {
  const CHALLENGE = /^Bearer/;

  async function expectChallenge(s: Scenario, secret: string) {
    const response = await bearerList(secret, s);
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"] ?? "").toMatch(CHALLENGE);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    return response;
  }

  it("answers an identical 401 with a Bearer challenge for every bad secret", async () => {
    const live = await world();
    const revoked = await world(ALL_FLAGS, { revokedAt: new Date() });
    const expired = await world(ALL_FLAGS, {
      expiresAt: new Date(Date.now() - 1000),
    });
    const unknown = `iop_${randomUUID().replaceAll("-", "")}`;

    const bodies = [
      (await expectChallenge(live.s, unknown)).body,
      (await expectChallenge(revoked.s, revoked.secret)).body,
      (await expectChallenge(expired.s, expired.secret)).body,
    ];

    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect((await bearerList(live.secret, live.s)).status).toBe(200);
  });

  it("treats expiresAt at or before now as expired", async () => {
    const atNow = await world(ALL_FLAGS, { expiresAt: new Date() });
    const later = await world(ALL_FLAGS, {
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await expectChallenge(atNow.s, atNow.secret);
    expect((await bearerList(later.secret, later.s)).status).toBe(200);
  });

  it("answers 401 for a disabled user", async () => {
    const { s, secret, cookie } = await world();
    expect((await bearerList(secret, s)).status).toBe(200);
    await client.query('UPDATE "User" SET "disabledAt" = now() WHERE id = $1', [
      s.member.id,
    ]);

    await expectChallenge(s, secret);
    expect((await call("get", "/auth/profile", cookie)).status).toBe(401);
  });

  it("answers 403 ONBOARDING_REQUIRED while a temporary password is pending", async () => {
    const { s, secret } = await world();
    await prisma.user.update({
      where: { id: s.member.id },
      data: {
        mustChangePassword: true,
        temporaryPasswordExpiresAt: new Date(Date.now() + DAY_MS),
      },
    });

    const response = await bearerList(secret, s);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ONBOARDING_REQUIRED");
  });

  it.each([
    ["a Basic scheme", "Basic dXNlcjpwYXNz"],
    ["Bearer without a value", "Bearer"],
    ["Bearer with only a space", "Bearer "],
    ["Bearer with two values", "Bearer one two"],
  ])("answers 401 for %s", async (_label, header) => {
    const { s } = await world();

    const response = await call(
      "get",
      `/invoices?${scopeQuery(s)}`,
      undefined,
    ).set("Authorization", header);

    expect(response.status).toBe(401);
  });
});

describe("RP0-16 a token never widens the owner's permissions (AC-09)", () => {
  it("answers 403 FORBIDDEN when the owner lacks what the token carries", async () => {
    const { s, secret } = await world(
      { readInvoices: true },
      { scopes: READ_CREATE },
    );

    const response = await bearerCreate(secret, payload(s));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect((await bearerList(secret, s)).status).toBe(200);
    expect(await invoiceCount(s.org.id)).toBe(0);
  });

  it("answers 403 INSUFFICIENT_SCOPE when the token lacks what the owner has", async () => {
    const { s, secret } = await world(ALL_FLAGS, {
      scopes: ["invoices:create"],
    });
    const invoice = await seed(s.org.id, s.member.id);

    const created = await bearerCreate(secret, payload(s));
    const listed = await bearerList(secret, s);
    const detail = await bearerDetail(secret, s, invoice.id);
    const removed = await bearerRemove(secret, s, invoice.id);

    expect(created.status).toBe(201);
    for (const response of [listed, detail, removed]) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("INSUFFICIENT_SCOPE");
    }
    expect((await stored(invoice.id)).deletedAt).toBeNull();
  });

  it("CR-009 never widens a token with the owner's ADMIN role: same 403/404 as before", async () => {
    const s = await scenario();
    const invoice = await seed(s.org.id, s.admin.id);
    const grouped = await seed(s.org.id, s.admin.id, s.group.id);
    // The scenario ADMIN has every flag false and is in no group.
    const orgToken = await seedApiToken(prisma, {
      userId: s.admin.id,
      organizationId: s.org.id,
    });
    const groupToken = await seedApiToken(prisma, {
      userId: s.admin.id,
      organizationId: s.org.id,
      groupId: s.group.id,
    });

    const orgList = await bearerList(orgToken.secret, s);
    const orgDetail = await bearerDetail(orgToken.secret, s, invoice.id);
    const groupList = await bearerList(groupToken.secret, s, s.group.id);
    const groupDetail = await bearerDetail(
      groupToken.secret,
      s,
      grouped.id,
      s.group.id,
    );
    // The same owner through the session is widened.
    const session = await call(
      "get",
      `/invoices?${scopeQuery(s)}`,
      await cookieFor(s.admin),
    );

    expect(orgList.status).toBe(403);
    expect(orgDetail.status).toBe(403);
    expect(groupList.status).toBe(404);
    expect(groupDetail.status).toBe(404);
    expect(session.status).toBe(200);
  });

  it("CR-009 never widens a token owned by the platform administrator", async () => {
    const s = await scenario();
    const invoice = await seed(s.org.id, s.admin.id);
    const issued = await seedApiToken(prisma, {
      userId: platform.id,
      organizationId: s.org.id,
    });

    const listed = await bearerList(issued.secret, s);
    const detail = await bearerDetail(issued.secret, s, invoice.id);
    const session = await call(
      "get",
      `/invoices?${scopeQuery(s)}`,
      platformCookie,
    );

    expect(listed.status).toBe(404);
    expect(detail.status).toBe(404);
    expect(session.status).toBe(200);
  });

  // Guard for CR-330: each of the four bearer operations hands the token to
  // its service. If a handler forgot it, the owner's full permissions would
  // let the request through and one of these would answer 2xx.
  it.each([
    ["create", "invoices:create"],
    ["list", "invoices:read"],
    ["detail", "invoices:read"],
    ["delete", "invoices:delete-own"],
  ] as const)(
    "rejects Bearer %s with INSUFFICIENT_SCOPE when only %s is missing",
    async (operation, missing) => {
      const everyScope: ApiScope[] = [
        "invoices:read",
        "invoices:create",
        "invoices:delete-own",
        "invoices:delete-others",
      ];
      const { s, secret } = await world(ALL_FLAGS, {
        scopes: everyScope.filter((scope) => scope !== missing),
      });
      const invoice = await seed(s.org.id, s.member.id);

      const response = await {
        create: () => bearerCreate(secret, payload(s)),
        list: () => bearerList(secret, s),
        detail: () => bearerDetail(secret, s, invoice.id),
        delete: () => bearerRemove(secret, s, invoice.id),
      }[operation]();

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("INSUFFICIENT_SCOPE");
      expect(await invoiceCount(s.org.id)).toBe(1);
      expect((await stored(invoice.id)).deletedAt).toBeNull();
    },
  );

  it("separates delete-own from delete-others", async () => {
    const own = await world(ALL_FLAGS, { scopes: ["invoices:delete-own"] });
    const others = await world(ALL_FLAGS, {
      scopes: ["invoices:delete-others"],
    });
    const mine = await seed(own.s.org.id, own.s.member.id);
    const foreign = await seed(own.s.org.id, own.s.admin.id);

    expect((await bearerRemove(own.secret, own.s, foreign.id)).status).toBe(
      403,
    );
    expect((await bearerRemove(own.secret, own.s, mine.id)).status).toBe(204);

    const theirs = await seed(others.s.org.id, others.s.admin.id);
    const ownRow = await seed(others.s.org.id, others.s.member.id);
    expect(
      (await bearerRemove(others.secret, others.s, theirs.id)).status,
    ).toBe(204);
    expect(
      (await bearerRemove(others.secret, others.s, ownRow.id)).status,
    ).toBe(403);
  });

  it("applies the owner's current permissions on every request", async () => {
    const { s, secret, cookie } = await world(ALL_FLAGS, {
      scopes: READ_CREATE,
    });
    const adminCookie = await cookieFor(s.admin);
    expect((await bearerCreate(secret, payload(s))).status).toBe(201);

    const narrowed = await call(
      "put",
      orgFlagsPath(s, s.member.id),
      adminCookie,
      {
        permissions: { ...NO_FLAGS, readInvoices: true },
      },
    );

    expect(narrowed.status).toBe(200);
    expect((await bearerCreate(secret, payload(s))).status).toBe(403);
    expect((await bearerList(secret, s)).status).toBe(200);
    expect(cookie).toBeDefined();
  });

  it("lets an organization token reach the organization and every group", async () => {
    const { s, secret } = await world(ALL_FLAGS, { scopes: READ_CREATE });
    const other = await makeGroup(s.org.id, "Other");

    for (const groupId of [null, s.group.id, other.id]) {
      const created = await bearerCreate(secret, payload(s, { groupId }));
      expect(created.status).toBe(201);
      expect((await bearerList(secret, s, groupId)).status).toBe(200);
    }
  });

  it("limits an organization token to the owner's group-level permission (org OR group)", async () => {
    const { s, secret } = await world(NO_FLAGS, {
      scopes: ["invoices:create"],
    });
    await addToGroup(s.group.id, s.member.id, s.org.id, {
      createInvoices: true,
    });

    const inGroup = await bearerCreate(
      secret,
      payload(s, { groupId: s.group.id }),
    );
    const inOrganization = await bearerCreate(secret, payload(s));

    expect(inGroup.status).toBe(201);
    expect(inOrganization.status).toBe(403);
  });

  it("never gives the platform administrator invoice access, token or not", async () => {
    const s = await scenario();
    const issued = await seedApiToken(prisma, {
      userId: platform.id,
      organizationId: s.org.id,
    });
    const invoice = await seed(s.org.id, s.member.id);

    const responses = [
      await bearerCreate(issued.secret, payload(s)),
      await bearerList(issued.secret, s),
      await bearerDetail(issued.secret, s, invoice.id),
      await bearerRemove(issued.secret, s, invoice.id),
    ];

    for (const response of responses) expect(response.status).toBe(404);
    expect(await invoiceCount(s.org.id)).toBe(1);
    expect((await stored(invoice.id)).deletedAt).toBeNull();
  });
});

describe("RP0-16 a group token stays inside its group (AC-09, SUP-1)", () => {
  async function groupWorld() {
    const w = await world(ALL_FLAGS, { onGroup: true });
    const other = await makeGroup(w.s.org.id, "Other");
    return { ...w, other };
  }

  it("operates inside its own group", async () => {
    const { s, secret } = await groupWorld();

    const created = await bearerCreate(
      secret,
      payload(s, { groupId: s.group.id }),
    );
    expect(created.status).toBe(201);
    const id = created.body.invoice.id as string;

    const listed = await bearerList(secret, s, s.group.id);
    expect(listed.status).toBe(200);
    for (const item of listed.body.items) {
      expect(item.groupId).toBe(s.group.id);
    }
    expect((await bearerDetail(secret, s, id, s.group.id)).status).toBe(200);
    expect((await bearerRemove(secret, s, id, s.group.id)).status).toBe(204);
  });

  it("answers 403 INSUFFICIENT_SCOPE for the organization scope and another group", async () => {
    const { s, secret, other } = await groupWorld();
    const inOrg = await seed(s.org.id, s.member.id);
    const inOther = await seed(s.org.id, s.member.id, other.id);

    const responses = [
      await bearerCreate(secret, payload(s)),
      await bearerCreate(secret, payload(s, { groupId: other.id })),
      await bearerList(secret, s),
      await bearerList(secret, s, other.id),
      await bearerDetail(secret, s, inOrg.id),
      await bearerDetail(secret, s, inOther.id, other.id),
      await bearerRemove(secret, s, inOrg.id),
      await bearerRemove(secret, s, inOther.id, other.id),
    ];

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("INSUFFICIENT_SCOPE");
    }
    expect((await stored(inOrg.id)).deletedAt).toBeNull();
    expect((await stored(inOther.id)).deletedAt).toBeNull();
    expect(await invoiceCount(s.org.id)).toBe(2);
  });

  it("answers the usual indistinguishable 404 when the owner could not see the scope", async () => {
    const { s, secret } = await groupWorld();
    const foreign = await scenario();
    const foreignGroup = await makeGroup(foreign.org.id, "Foreign");
    const foreignInvoice = await seed(foreign.org.id, foreign.member.id);

    const missingGroup = await bearerCreate(
      secret,
      payload(s, { groupId: MISSING }),
    );
    const responses = [
      await bearerCreate(secret, payload(s, { groupId: foreignGroup.id })),
      await bearerCreate(secret, payload(foreign)),
      await bearerList(secret, foreign),
      await bearerDetail(secret, foreign, foreignInvoice.id),
      await bearerRemove(secret, foreign, foreignInvoice.id),
    ];

    expect(missingGroup.status).toBe(404);
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    }
    expect(responses[0].body).toEqual(missingGroup.body);
    expect(await invoiceCount(foreign.org.id)).toBe(1);
  });
});

describe("RP0-16 the next Bearer request sees every revocation (AC-10)", () => {
  it("blocks after the token is revoked through the API", async () => {
    const { s, id, secret, cookie } = await world();
    expect((await bearerList(secret, s)).status).toBe(200);

    expect((await call("delete", `/api-tokens/${id}`, cookie)).status).toBe(
      204,
    );

    expect((await bearerList(secret, s)).status).toBe(401);
    expect((await bearerCreate(secret, payload(s))).status).toBe(401);
    expect(await invoiceCount(s.org.id)).toBe(0);
  });

  it("blocks after the token expires", async () => {
    const { s, id, secret } = await world();
    expect((await bearerList(secret, s)).status).toBe(200);

    await client.query(
      `UPDATE "ApiToken" SET "createdAt" = now() - interval '2 days',
         "expiresAt" = now() - interval '1 second' WHERE id = $1`,
      [id],
    );

    expect((await bearerList(secret, s)).status).toBe(401);
  });

  it("blocks after the membership is removed", async () => {
    const { s, secret } = await world();
    const adminCookie = await cookieFor(s.admin);
    expect((await bearerList(secret, s)).status).toBe(200);

    const removal = await call(
      "delete",
      membershipPath(s, s.member.id),
      adminCookie,
    );

    expect(removal.status).toBe(204);
    const after = await bearerList(secret, s);
    expect(after.status).toBe(404);
    expect((await bearerCreate(secret, payload(s))).status).toBe(404);
  });

  it("blocks writes after a PUT removes the permission", async () => {
    const { s, secret } = await world();
    const adminCookie = await cookieFor(s.admin);
    expect((await bearerCreate(secret, payload(s))).status).toBe(201);

    const revoke = await call(
      "put",
      orgFlagsPath(s, s.member.id),
      adminCookie,
      {
        permissions: NO_FLAGS,
      },
    );

    expect(revoke.status).toBe(200);
    expect((await bearerCreate(secret, payload(s))).status).toBe(403);
    expect((await bearerList(secret, s)).status).toBe(403);
  });

  it("blocks after the owner changes their own password", async () => {
    const { s, secret, cookie } = await world();
    expect((await bearerList(secret, s)).status).toBe(200);

    const changed = await call("post", "/auth/change-password", cookie, {
      currentPassword: PASSWORD,
      newPassword: `another-password-${randomUUID()}`,
    });

    expect(changed.status).toBe(204);
    expect((await bearerList(secret, s)).status).toBe(401);
  });

  it("blocks after the user is disabled", async () => {
    const { s, secret } = await world();
    expect((await bearerList(secret, s)).status).toBe(200);

    const disabled = await call(
      "post",
      `/admin/users/${s.member.id}/deactivation`,
      platformCookie,
    );

    expect(disabled.status).toBe(200);
    expect((await bearerList(secret, s)).status).toBe(401);
  });
});

const DEADLOCK_POLL_MS = 250;
const DEADLOCK_STABLE_MS = 1500;
const DEADLOCK_MAX_WAIT_MS = 3000;

async function readDeadlocks() {
  // Each read must see fresh statistics, not the snapshot of the first one.
  await client.query("SELECT pg_stat_clear_snapshot()");
  const result = await client.query(
    "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()",
  );
  const [row] = result.rows as Array<{ deadlocks: string }>;
  return Number(row?.deadlocks ?? 0);
}

/**
 * Deadlocks PostgreSQL has reported for this database. Other backends publish
 * their counters when they go idle (about a second later), and
 * pg_stat_force_next_flush() only flushes this connection's own, so the view is
 * polled until the value has not changed for a stable window (or the cap).
 */
async function deadlocks() {
  const started = Date.now();
  let value = await readDeadlocks();
  let changedAt = started;
  while (
    Date.now() - changedAt < DEADLOCK_STABLE_MS &&
    Date.now() - started < DEADLOCK_MAX_WAIT_MS
  ) {
    await new Promise((resolve) => setTimeout(resolve, DEADLOCK_POLL_MS));
    const next = await readDeadlocks();
    if (next !== value) {
      value = next;
      changedAt = Date.now();
    }
  }
  return value;
}

describe("RP0-16 revocation races (AC-10)", () => {
  async function withHolder<T>(work: (holder: Client) => Promise<T>) {
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      return await work(holder);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  }

  it("makes a Bearer create wait for a revoking permission change and then answer 403", async () => {
    const { s, secret } = await world();

    const response = await withHolder(async (holder) => {
      await holder.query(
        'SELECT id FROM "OrganizationMembership" WHERE "userId" = $1 AND "organizationId" = $2 FOR UPDATE',
        [s.member.id, s.org.id],
      );
      await holder.query(
        'UPDATE "OrganizationMembership" SET "createInvoices" = false WHERE "userId" = $1 AND "organizationId" = $2',
        [s.member.id, s.org.id],
      );
      const pending = bearerCreate(secret, payload(s)).then((r) => r);
      await waitUntilBlocked('%FROM "OrganizationMembership"%FOR SHARE%');
      await holder.query("COMMIT");
      return pending;
    });

    expect(response.status).toBe(403);
    expect(await invoiceCount(s.org.id)).toBe(0);
  });

  it("makes a permission change wait for an in-flight Bearer create and then apply", async () => {
    const { s, secret } = await world();
    const adminCookie = await cookieFor(s.admin);

    const revoke = await withHolder(async (holder) => {
      await holder.query(
        'SELECT id FROM "OrganizationMembership" WHERE "userId" = $1 AND "organizationId" = $2 FOR SHARE',
        [s.member.id, s.org.id],
      );
      const pending = call("put", orgFlagsPath(s, s.member.id), adminCookie, {
        permissions: NO_FLAGS,
      }).then((r) => r);
      await waitUntilBlocked('%FROM "OrganizationMembership"%FOR UPDATE%');
      await holder.query("COMMIT");
      return pending;
    });

    expect(revoke.status).toBe(200);
    expect((await bearerCreate(secret, payload(s))).status).toBe(403);
  });

  it("serializes a Bearer create and its replay against a concurrent permission revocation", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { s, secret } = await world();
      const adminCookie = await cookieFor(s.admin);
      const body = payload(s);
      const key = newKey();

      const [created, revoke] = await Promise.all([
        bearerCreate(secret, body, key).then((r) => r),
        call("put", orgFlagsPath(s, s.member.id), adminCookie, {
          permissions: NO_FLAGS,
        }).then((r) => r),
      ]);

      expect(revoke.status).toBe(200);
      expect([201, 403]).toContain(created.status);
      expect(await invoiceCount(s.org.id)).toBe(created.status === 201 ? 1 : 0);
      const replay = await bearerCreate(secret, body, key);
      expect(replay.status).toBe(403);
      expect(replay.body.invoice).toBeUndefined();
    }
  });

  // Requires the Bearer path to take a share lock on the ApiToken row (in the
  // same transaction as the action), so a revocation that committed first is
  // always seen: no request is authorized after the revocation commit.
  it("makes a Bearer create wait for a token revocation and then answer 401", async () => {
    const { s, id, secret } = await world();

    const response = await withHolder(async (holder) => {
      await holder.query('SELECT id FROM "ApiToken" WHERE id = $1 FOR UPDATE', [
        id,
      ]);
      await holder.query(
        'UPDATE "ApiToken" SET "revokedAt" = now() WHERE id = $1',
        [id],
      );
      const pending = bearerCreate(secret, payload(s)).then((r) => r);
      await waitUntilBlocked('%FROM "ApiToken"%FOR%SHARE%');
      await holder.query("COMMIT");
      return pending;
    });

    expect(response.status).toBe(401);
    expect(await invoiceCount(s.org.id)).toBe(0);
  });

  it("serializes a Bearer create and its replay against a concurrent token revoke", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { s, id, secret, cookie } = await world();
      const body = payload(s);
      const key = newKey();

      const [created, revoke] = await Promise.all([
        bearerCreate(secret, body, key).then((r) => r),
        call("delete", `/api-tokens/${id}`, cookie).then((r) => r),
      ]);

      expect(revoke.status).toBe(204);
      expect([201, 401]).toContain(created.status);
      expect(await invoiceCount(s.org.id)).toBe(created.status === 201 ? 1 : 0);
      const replay = await bearerCreate(secret, body, key);
      expect(replay.status).toBe(401);
    }
  });

  // The statements a password change and a user deactivation run, taken in
  // the same order as production: User row lock, the user change, and the
  // revocation of every live token of the user.
  const CREDENTIAL_CHANGES = {
    "a password change": `UPDATE "User" SET "passwordHash" = "passwordHash" WHERE id = $1`,
    "a user deactivation": `UPDATE "User" SET "disabledAt" = now() WHERE id = $1`,
  } as const;

  describe.each(Object.entries(CREDENTIAL_CHANGES))(
    "against %s",
    (_label, userChange) => {
      async function holdCredentialChange(holder: Client, userId: string) {
        await holder.query(
          'SELECT id FROM "User" WHERE id = $1 FOR NO KEY UPDATE',
          [userId],
        );
        await holder.query(userChange, [userId]);
        await holder.query(
          'UPDATE "ApiToken" SET "revokedAt" = now() WHERE "userId" = $1 AND "revokedAt" IS NULL',
          [userId],
        );
      }

      it("makes a Bearer create wait for it and then answer 401, replay included", async () => {
        const { s, secret } = await world();
        const body = payload(s);
        const key = newKey();

        const response = await withHolder(async (holder) => {
          await holdCredentialChange(holder, s.member.id);
          const pending = bearerCreate(secret, body, key).then((r) => r);
          await waitUntilBlocked('%FROM "ApiToken"%FOR%SHARE%');
          await holder.query("COMMIT");
          return pending;
        });

        expect(response.status).toBe(401);
        expect(await invoiceCount(s.org.id)).toBe(0);
        expect((await bearerCreate(secret, body, key)).status).toBe(401);
      });

      it("makes a Bearer DELETE wait for it and then answer 401, repeat included", async () => {
        const { s, secret } = await world();
        const invoice = await seed(s.org.id, s.member.id);

        const response = await withHolder(async (holder) => {
          await holdCredentialChange(holder, s.member.id);
          const pending = bearerRemove(secret, s, invoice.id).then((r) => r);
          await waitUntilBlocked('%FROM "ApiToken"%FOR%SHARE%');
          await holder.query("COMMIT");
          return pending;
        });

        expect(response.status).toBe(401);
        expect((await stored(invoice.id)).deletedAt).toBeNull();
        expect((await bearerRemove(secret, s, invoice.id)).status).toBe(401);
      });
    },
  );

  // CR-340: the tests above simulate the credential change in SQL. These run
  // the real endpoints. A holder keeps the token row locked FOR UPDATE, so the
  // Bearer write (FOR SHARE) and the endpoint's token revocation (UPDATE) both
  // queue behind it, Bearer first; releasing the holder lets them race through
  // the production lock order.
  const REAL_CREDENTIAL_CHANGES = {
    "a real password change": {
      expectedStatus: 204,
      fire: (_s: Scenario, cookie: string) =>
        call("post", "/auth/change-password", cookie, {
          currentPassword: PASSWORD,
          newPassword: `another-password-${randomUUID()}`,
        }),
      // CR-351: the change applied exactly once and rotated the session.
      verify: async (
        s: Scenario,
        change: { headers: Record<string, unknown> },
      ) => {
        const rotated = String(
          (change.headers["set-cookie"] as string[] | undefined)?.[0] ?? "",
        ).split(";")[0];
        expect(rotated).toMatch(/^invoiceops_session=.+/);
        expect((await call("get", "/auth/profile", rotated)).status).toBe(200);
        expect(
          await prisma.platformAdministrativeAuditEvent.count({
            where: { type: "PASSWORD_CHANGED", targetUserId: s.member.id },
          }),
        ).toBe(1);
      },
    },
    "a real user deactivation": {
      expectedStatus: 200,
      fire: (s: Scenario) =>
        call(
          "post",
          `/admin/users/${s.member.id}/deactivation`,
          platformCookie,
        ),
    },
    // The RUT is a unique key: changing it takes a stronger row lock than the
    // other changes, so it needs its own proof of the lock order.
    "a real RUT change": {
      expectedStatus: 200,
      fire: (s: Scenario) =>
        call("patch", `/admin/users/${s.member.id}`, platformCookie, {
          rut: formatRut(randomRut()),
        }),
    },
  } as const;

  describe.each(Object.entries(REAL_CREDENTIAL_CHANGES))(
    "racing %s",
    (_label, scenarioDefinition) => {
      const { expectedStatus, fire } = scenarioDefinition;
      async function raceWith(
        setup: Awaited<ReturnType<typeof world>>,
        bearerRequest: () => PromiseLike<{ status: number }>,
      ) {
        // CR-350: the retry in runSerializable would mask a deadlock, so the
        // race asserts that PostgreSQL reported no new deadlock (pg_stat is the
        // authority: a deadlock retried as 40P01 still counts there). A
        // legitimate 40001 serialization retry is tolerated, so the log is only
        // checked for a flow that gave up (retries exhausted, a 503).
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const deadlocksBefore = await deadlocks();
        try {
          const outcome = await withHolder(async (holder) => {
            await holder.query(
              'SELECT id FROM "ApiToken" WHERE id = $1 FOR UPDATE',
              [setup.id],
            );
            const bearer = Promise.resolve(bearerRequest());
            await waitUntilBlocked('%FROM "ApiToken"%FOR%SHARE%');
            const change = fire(setup.s, setup.cookie).then((r) => r);
            await waitUntilBlocked("%UPDATE%ApiToken%");
            await holder.query("COMMIT");
            return { bearer: await bearer, change: await change };
          });
          const gaveUp = warn.mock.calls.filter(([line]) => {
            try {
              const event = JSON.parse(String(line)) as {
                event?: string;
                outcome?: string;
              };
              return (
                event.event === "transaction.conflict" &&
                event.outcome === "gave_up"
              );
            } catch {
              return false;
            }
          });
          expect(gaveUp).toEqual([]);
          expect(await deadlocks()).toBe(deadlocksBefore);
          return outcome;
        } finally {
          warn.mockRestore();
        }
      }

      it("never creates an invoice after the credential change committed", async () => {
        const setup = await world();
        const { s, secret } = setup;
        const body = payload(s);
        const key = newKey();

        const { bearer, change } = await raceWith(setup, () =>
          bearerCreate(secret, body, key),
        );

        expect(change.status).toBe(expectedStatus);
        if ("verify" in scenarioDefinition) {
          await scenarioDefinition.verify(s, change);
        }
        expect([201, 401]).toContain(bearer.status);
        expect(await invoiceCount(s.org.id)).toBe(
          bearer.status === 201 ? 1 : 0,
        );
        expect((await bearerCreate(secret, body, key)).status).toBe(401);
        expect((await bearerCreate(secret, payload(s))).status).toBe(401);
        expect(await invoiceCount(s.org.id)).toBe(
          bearer.status === 201 ? 1 : 0,
        );
      });

      it("never deletes an invoice after the credential change committed", async () => {
        const setup = await world();
        const { s, secret } = setup;
        const invoice = await seed(s.org.id, s.member.id);

        const { bearer, change } = await raceWith(setup, () =>
          bearerRemove(secret, s, invoice.id),
        );

        expect(change.status).toBe(expectedStatus);
        expect([204, 401]).toContain(bearer.status);
        expect((await stored(invoice.id)).deletedAt === null).toBe(
          bearer.status === 401,
        );
        expect((await bearerRemove(secret, s, invoice.id)).status).toBe(401);
      });
    },
  );

  it("answers 401 to a Bearer create that was blocked while its token expired", async () => {
    const { s, id, secret } = await world();

    const response = await withHolder(async (holder) => {
      await holder.query('SELECT id FROM "ApiToken" WHERE id = $1 FOR UPDATE', [
        id,
      ]);
      await holder.query(
        `UPDATE "ApiToken" SET "createdAt" = now() - interval '2 days',
           "expiresAt" = now() - interval '1 second' WHERE id = $1`,
        [id],
      );
      const pending = bearerCreate(secret, payload(s)).then((r) => r);
      await waitUntilBlocked('%FROM "ApiToken"%FOR%SHARE%');
      await holder.query("COMMIT");
      return pending;
    });

    expect(response.status).toBe(401);
    expect(await invoiceCount(s.org.id)).toBe(0);
  });

  it("answers 401 to the next Bearer create and DELETE once the token expired after a write", async () => {
    const { s, id, secret } = await world();
    const created = await bearerCreate(secret, payload(s));
    expect(created.status).toBe(201);

    await client.query(
      `UPDATE "ApiToken" SET "createdAt" = now() - interval '2 days',
         "expiresAt" = now() - interval '1 second' WHERE id = $1`,
      [id],
    );

    expect((await bearerCreate(secret, payload(s))).status).toBe(401);
    expect(
      (await bearerRemove(secret, s, created.body.invoice.id as string)).status,
    ).toBe(401);
    expect(await invoiceCount(s.org.id)).toBe(1);
  });

  it("makes a Bearer DELETE wait for a membership removal and then answer 404", async () => {
    const { s, secret } = await world();
    const invoice = await seed(s.org.id, s.member.id);

    const response = await withHolder(async (holder) => {
      await holder.query(
        'SELECT id FROM "OrganizationMembership" WHERE "userId" = $1 AND "organizationId" = $2 FOR UPDATE',
        [s.member.id, s.org.id],
      );
      await holder.query(
        'DELETE FROM "OrganizationMembership" WHERE "userId" = $1 AND "organizationId" = $2',
        [s.member.id, s.org.id],
      );
      const pending = bearerRemove(secret, s, invoice.id).then((r) => r);
      await waitUntilBlocked('%FROM "OrganizationMembership"%FOR SHARE%');
      await holder.query("COMMIT");
      return pending;
    });

    expect(response.status).toBe(404);
    expect((await stored(invoice.id)).deletedAt).toBeNull();
  });

  it("serializes a Bearer DELETE against a concurrent membership removal", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { s, secret } = await world();
      const adminCookie = await cookieFor(s.admin);
      const invoice = await seed(s.org.id, s.member.id);

      const [deleted, removal] = await Promise.all([
        bearerRemove(secret, s, invoice.id).then((r) => r),
        call("delete", membershipPath(s, s.member.id), adminCookie).then(
          (r) => r,
        ),
      ]);

      expect(removal.status).toBe(204);
      expect([204, 404]).toContain(deleted.status);
      expect((await stored(invoice.id)).deletedAt !== null).toBe(
        deleted.status === 204,
      );
      expect((await bearerRemove(secret, s, invoice.id)).status).toBe(404);
    }
  });
});

describe("RP0-16 idempotent replay through Bearer (AC-10)", () => {
  it("shares the replay between two tokens of the same user", async () => {
    const { s, secret } = await world(ALL_FLAGS, { scopes: READ_CREATE });
    const second = await seedApiToken(prisma, {
      userId: s.member.id,
      organizationId: s.org.id,
      scopes: READ_CREATE,
    });
    const body = payload(s);
    const key = newKey();

    const first = await bearerCreate(secret, body, key);
    const replay = await bearerCreate(second.secret, body, key);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.invoice.id).toBe(first.body.invoice.id);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(first.headers["idempotency-replayed"]).toBeUndefined();
    expect(await invoiceCount(s.org.id)).toBe(1);
  });

  it("replays a session-created invoice to a Bearer request of the same user", async () => {
    const { s, secret, cookie } = await world(ALL_FLAGS, {
      scopes: READ_CREATE,
    });
    const body = payload(s);
    const key = newKey();

    const first = await call("post", "/invoices", cookie, body).set(
      "Idempotency-Key",
      key,
    );
    const replay = await bearerCreate(secret, body, key);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.invoice.id).toBe(first.body.invoice.id);
    expect(await invoiceCount(s.org.id)).toBe(1);
  });

  it("never hands another user's token the replay", async () => {
    const { s, secret } = await world(ALL_FLAGS, { scopes: READ_CREATE });
    const colleague = await makeUser("Colleague");
    await join(colleague.id, s.org.id, "USER", ALL_FLAGS);
    const theirs = await seedApiToken(prisma, {
      userId: colleague.id,
      organizationId: s.org.id,
      scopes: READ_CREATE,
    });
    const key = newKey();

    const mine = await bearerCreate(secret, payload(s), key);
    const other = await bearerCreate(theirs.secret, payload(s), key);

    expect(mine.status).toBe(201);
    expect(other.status).toBe(201);
    expect(other.body.invoice.id).not.toBe(mine.body.invoice.id);
    expect(other.body.invoice.createdByUserId).toBe(colleague.id);
    expect(other.headers["idempotency-replayed"]).toBeUndefined();
    expect(await invoiceCount(s.org.id)).toBe(2);
  });

  it("answers 410 INVOICE_DELETED to a replay after a Bearer DELETE", async () => {
    const { s, secret } = await world(ALL_FLAGS, {
      scopes: ["invoices:create", "invoices:delete-own"],
    });
    const body = payload(s);
    const key = newKey();
    const created = await bearerCreate(secret, body, key);
    expect(created.status).toBe(201);
    const id = created.body.invoice.id as string;

    expect((await bearerRemove(secret, s, id)).status).toBe(204);
    const replay = await bearerCreate(secret, body, key);

    expect(replay.status).toBe(410);
    expect(replay.body.error.code).toBe("INVOICE_DELETED");
    expect((await stored(id)).deletedAt).toBeInstanceOf(Date);
  });
});
