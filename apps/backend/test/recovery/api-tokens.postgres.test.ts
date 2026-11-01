import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { MAX_ACTIVE_TOKENS_PER_ORGANIZATION } from "../../src/features/api-tokens/services.js";
import {
  DAY_MS,
  bearerCall,
  seedApiToken,
  sha256Hex,
  type ApiScope,
} from "./api-token-fixtures.js";
import {
  membershipFixtures,
  NO_FLAGS,
  PASSWORD,
  type Scenario,
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
  makeGroup,
  addToGroup,
  cookieFor,
  call,
  designatePlatformAdministrator,
  scenario,
} = membershipFixtures({ prisma, client, auth, app, url });

const MISSING = "00000000-0000-4000-8000-000000000000";
const READ_CREATE = {
  ...NO_FLAGS,
  readInvoices: true,
  createInvoices: true,
};
const METADATA_KEYS = [
  "createdAt",
  "expiresAt",
  "groupId",
  "id",
  "name",
  "organizationId",
  "revokedAt",
  "scopes",
];

let platformCookie: string;

beforeAll(async () => {
  await client.connect();
  const platform = await makeUser("Platform Administrator");
  await designatePlatformAdministrator(platform.id);
  platformCookie = await cookieFor(platform);
});
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

const inDays = (days: number) => new Date(Date.now() + days * DAY_MS);

function requestBody(s: Scenario, overrides: Record<string, unknown> = {}) {
  return {
    name: "ci pipeline",
    organizationId: s.org.id,
    scopes: ["invoices:read"] satisfies ApiScope[],
    expiresAt: inDays(7).toISOString(),
    ...overrides,
  };
}

const emit = (cookie: string | undefined, body: unknown) =>
  call("post", "/api-tokens", cookie, body);

const tokenRows = (userId: string) =>
  prisma.apiToken.findMany({ where: { userId }, orderBy: { id: "asc" } });

async function flaggedScenario(
  flags: Partial<typeof READ_CREATE> = READ_CREATE,
) {
  const s = await scenario();
  await prisma.organizationMembership.update({
    where: {
      userId_organizationId: { userId: s.member.id, organizationId: s.org.id },
    },
    data: { ...NO_FLAGS, ...flags },
  });
  return { s, cookie: await cookieFor(s.member) };
}

describe("RP0-16 POST /api/v1/api-tokens emission (AC-06)", () => {
  it("answers 201 with metadata, a one-time secret and no-store", async () => {
    const { s, cookie } = await flaggedScenario();
    const body = requestBody(s, {
      scopes: ["invoices:read", "invoices:create"],
    });

    const response = await emit(cookie, body);

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(Object.keys(response.body).sort()).toEqual(["secret", "token"]);
    expect(Object.keys(response.body.token).sort()).toEqual(METADATA_KEYS);
    expect(response.body.token).toMatchObject({
      name: body.name,
      organizationId: s.org.id,
      groupId: null,
      scopes: ["invoices:read", "invoices:create"],
      revokedAt: null,
    });
    expect(new Date(response.body.token.expiresAt).toISOString()).toBe(
      body.expiresAt,
    );
    expect(response.body.secret).toMatch(/^iop_[A-Za-z0-9_-]{43,}$/);
    expect(JSON.stringify(response.body)).not.toContain("tokenHash");
  });

  it("stores only the SHA-256 of the secret", async () => {
    const { s, cookie } = await flaggedScenario();
    const response = await emit(cookie, requestBody(s));
    expect(response.status).toBe(201);
    const { secret, token } = response.body;

    const row = await prisma.apiToken.findUniqueOrThrow({
      where: { id: token.id },
    });
    expect(row.tokenHash).toBe(sha256Hex(secret));
    expect(row.userId).toBe(s.member.id);
    expect(row.revokedAt).toBeNull();
    const dump = await client.query(
      'SELECT row_to_json(t)::text AS body FROM "ApiToken" t WHERE id = $1',
      [token.id],
    );
    expect(dump.rows[0].body).not.toContain(secret);
  });

  it("returns a different secret for every emission", async () => {
    const { s, cookie } = await flaggedScenario();
    const first = await emit(cookie, requestBody(s));
    const second = await emit(cookie, requestBody(s));

    expect(first.body.secret).not.toBe(second.body.secret);
    expect(first.body.token.id).not.toBe(second.body.token.id);
  });

  it("accepts an expiry up to 30 days ahead", async () => {
    const { s, cookie } = await flaggedScenario();

    const response = await emit(
      cookie,
      requestBody(s, { expiresAt: new Date(Date.now() + 29.9 * DAY_MS) }),
    );

    expect(response.status).toBe(201);
  });

  it.each([
    ["missing", undefined],
    ["in the past", () => inDays(-1).toISOString()],
    ["beyond 30 days", () => inDays(31).toISOString()],
    ["not a date", () => "tomorrow"],
  ])(
    "answers 400 VALIDATION_ERROR for an expiresAt that is %s",
    async (_l, make) => {
      const { s, cookie } = await flaggedScenario();
      const body: Record<string, unknown> = requestBody(s);
      if (make) body.expiresAt = make();
      else delete body.expiresAt;

      const response = await emit(cookie, body);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(await tokenRows(s.member.id)).toHaveLength(0);
    },
  );

  it("answers 400 for an unknown scope or a client-supplied hash", async () => {
    const { s, cookie } = await flaggedScenario();

    for (const overrides of [
      { scopes: ["invoices:everything"] },
      { tokenHash: "x" },
    ]) {
      expect((await emit(cookie, requestBody(s, overrides))).status).toBe(400);
    }
    expect(await tokenRows(s.member.id)).toHaveLength(0);
  });

  it("keeps the Origin check and requires a session", async () => {
    const { s, cookie } = await flaggedScenario();

    const evil = await call("post", "/api-tokens", cookie, requestBody(s)).set(
      "Origin",
      "http://evil.example",
    );
    const anonymous = await emit(undefined, requestBody(s));

    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe("FORBIDDEN_ORIGIN");
    expect(anonymous.status).toBe(401);
    expect(await tokenRows(s.member.id)).toHaveLength(0);
  });
});

describe("RP0-16 emission authority (AC-07)", () => {
  it("answers 403 FORBIDDEN when a scope exceeds the current permissions", async () => {
    const { s, cookie } = await flaggedScenario(READ_CREATE);

    for (const scopes of [
      ["invoices:delete-own"],
      ["invoices:read", "invoices:delete-others"],
    ]) {
      const response = await emit(cookie, requestBody(s, { scopes }));
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
    expect(await tokenRows(s.member.id)).toHaveLength(0);
  });

  it("limits an organization token to the organization-level flags", async () => {
    const { s, cookie } = await flaggedScenario(NO_FLAGS);
    await addToGroup(s.group.id, s.member.id, s.org.id, {
      createInvoices: true,
    });

    const response = await emit(
      cookie,
      requestBody(s, { scopes: ["invoices:create"] }),
    );

    expect(response.status).toBe(403);
    expect(await tokenRows(s.member.id)).toHaveLength(0);
  });

  it("lets a group token carry the group-level flags", async () => {
    const { s, cookie } = await flaggedScenario(NO_FLAGS);
    await addToGroup(s.group.id, s.member.id, s.org.id, {
      createInvoices: true,
    });

    const allowed = await emit(
      cookie,
      requestBody(s, { groupId: s.group.id, scopes: ["invoices:create"] }),
    );
    const beyond = await emit(
      cookie,
      requestBody(s, { groupId: s.group.id, scopes: ["invoices:read"] }),
    );

    expect(allowed.status).toBe(201);
    expect(allowed.body.token.groupId).toBe(s.group.id);
    expect(beyond.status).toBe(403);
  });

  // Effective permission in a group is organization OR group. Group membership
  // is NOT required to emit a group token when the organization flags cover
  // the requested scopes (single assumption of the plan, isolated here).
  it("lets organization-level flags cover a group token without group membership", async () => {
    const { s, cookie } = await flaggedScenario(READ_CREATE);

    const response = await emit(
      cookie,
      requestBody(s, { groupId: s.group.id, scopes: ["invoices:read"] }),
    );

    expect(response.status).toBe(201);
    expect(response.body.token.groupId).toBe(s.group.id);
  });

  it("answers 404 for a group outside the organization or missing", async () => {
    const { s, cookie } = await flaggedScenario(READ_CREATE);
    const foreign = await scenario();
    const foreignGroup = await makeGroup(foreign.org.id, "Foreign");

    for (const groupId of [foreignGroup.id, MISSING]) {
      const response = await emit(cookie, requestBody(s, { groupId }));
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    }
    expect(await tokenRows(s.member.id)).toHaveLength(0);
  });

  it("answers the same 404 to a non-member, a missing org and the platform administrator", async () => {
    const s = await scenario();
    const outsiderCookie = await cookieFor(s.outsider);

    const responses = [
      await emit(outsiderCookie, requestBody(s)),
      await emit(platformCookie, requestBody(s)),
      await emit(outsiderCookie, requestBody(s, { organizationId: MISSING })),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    }
    expect(
      await prisma.apiToken.count({ where: { organizationId: s.org.id } }),
    ).toBe(0);
  });

  it("stops emitting once the membership is removed", async () => {
    const { s, cookie } = await flaggedScenario(READ_CREATE);
    await prisma.organizationMembership.delete({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
    });

    expect((await emit(cookie, requestBody(s))).status).toBe(404);
  });

  it("rejects Bearer on every token-management operation", async () => {
    const { s } = await flaggedScenario(READ_CREATE);
    const issued = await seedApiToken(prisma, {
      userId: s.member.id,
      organizationId: s.org.id,
    });

    const responses = [
      await bearerCall(
        app,
        "post",
        "/api-tokens",
        issued.secret,
        requestBody(s),
      ),
      await bearerCall(
        app,
        "get",
        `/api-tokens?organizationId=${s.org.id}`,
        issued.secret,
      ),
      await bearerCall(
        app,
        "delete",
        `/api-tokens/${issued.id}`,
        issued.secret,
      ),
    ];

    for (const response of responses) expect(response.status).toBe(401);
    const row = await prisma.apiToken.findUniqueOrThrow({
      where: { id: issued.id },
    });
    expect(row.revokedAt).toBeNull();
    expect(await tokenRows(s.member.id)).toHaveLength(1);
  });
});

describe("RP0-16 GET /api/v1/api-tokens (AC-11, SUP-3)", () => {
  it("lists only the caller's own tokens as metadata", async () => {
    const { s, cookie } = await flaggedScenario();
    const mine = await seedApiToken(prisma, {
      userId: s.member.id,
      organizationId: s.org.id,
    });
    const grouped = await seedApiToken(prisma, {
      userId: s.member.id,
      organizationId: s.org.id,
      groupId: s.group.id,
    });
    const others = await seedApiToken(prisma, {
      userId: s.admin.id,
      organizationId: s.org.id,
    });

    const response = await call(
      "get",
      `/api-tokens?organizationId=${s.org.id}`,
      cookie,
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ page: 1, total: 2 });
    expect(typeof response.body.pageSize).toBe("number");
    const ids = response.body.items.map((item: { id: string }) => item.id);
    expect(ids.sort()).toEqual([mine.id, grouped.id].sort());
    expect(ids).not.toContain(others.id);
    for (const item of response.body.items) {
      expect(Object.keys(item).sort()).toEqual(METADATA_KEYS);
    }
    const serialized = JSON.stringify(response.body);
    for (const secret of [mine.secret, grouped.secret, others.secret]) {
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(sha256Hex(secret));
    }
    expect(serialized).not.toContain("tokenHash");
  });

  it("filters by group and pages the result", async () => {
    const { s, cookie } = await flaggedScenario();
    for (let index = 0; index < 3; index += 1) {
      await seedApiToken(prisma, {
        userId: s.member.id,
        organizationId: s.org.id,
        groupId: s.group.id,
      });
    }
    await seedApiToken(prisma, {
      userId: s.member.id,
      organizationId: s.org.id,
    });

    const grouped = await call(
      "get",
      `/api-tokens?organizationId=${s.org.id}&groupId=${s.group.id}&page=2&pageSize=2`,
      cookie,
    );

    expect(grouped.status).toBe(200);
    expect(grouped.body).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(grouped.body.items).toHaveLength(1);
    expect(grouped.body.items[0].groupId).toBe(s.group.id);
  });

  it("shows a revoked token with its revokedAt and requires a session", async () => {
    const { s, cookie } = await flaggedScenario();
    const revoked = await seedApiToken(prisma, {
      userId: s.member.id,
      organizationId: s.org.id,
      revokedAt: new Date(),
    });
    const path = `/api-tokens?organizationId=${s.org.id}`;

    const response = await call("get", path, cookie);
    const anonymous = await call("get", path, undefined);

    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({ id: revoked.id });
    expect(typeof response.body.items[0].revokedAt).toBe("string");
    expect(anonymous.status).toBe(401);
  });

  it("answers 400 for a malformed query", async () => {
    const { cookie } = await flaggedScenario();

    for (const query of [
      "organizationId=nope",
      "",
      `organizationId=${MISSING}&page=0`,
    ]) {
      expect((await call("get", `/api-tokens?${query}`, cookie)).status).toBe(
        400,
      );
    }
  });
});

describe("RP0-16 DELETE /api/v1/api-tokens/{tokenId} (AC-11)", () => {
  it("revokes an own token with 204 and stays 204 when repeated", async () => {
    const { s, cookie } = await flaggedScenario();
    const issued = await seedApiToken(prisma, {
      userId: s.member.id,
      organizationId: s.org.id,
    });

    const first = await call("delete", `/api-tokens/${issued.id}`, cookie);
    const stamped = await prisma.apiToken.findUniqueOrThrow({
      where: { id: issued.id },
    });
    const second = await call("delete", `/api-tokens/${issued.id}`, cookie);
    const again = await prisma.apiToken.findUniqueOrThrow({
      where: { id: issued.id },
    });

    expect(first.status).toBe(204);
    expect(stamped.revokedAt).toBeInstanceOf(Date);
    expect(second.status).toBe(204);
    expect(again.revokedAt?.getTime()).toBe(stamped.revokedAt?.getTime());
  });

  it("answers the same 404 for someone else's, a missing and a malformed id", async () => {
    const { s, cookie } = await flaggedScenario();
    const foreign = await seedApiToken(prisma, {
      userId: s.admin.id,
      organizationId: s.org.id,
    });

    const responses = [
      await call("delete", `/api-tokens/${foreign.id}`, cookie),
      await call("delete", `/api-tokens/${MISSING}`, cookie),
      await call("delete", "/api-tokens/not-a-uuid", cookie),
    ];

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual(responses[1].body);
    }
    const row = await prisma.apiToken.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    expect(row.revokedAt).toBeNull();
  });

  it("keeps the Origin check and requires a session", async () => {
    const { s, cookie } = await flaggedScenario();
    const issued = await seedApiToken(prisma, {
      userId: s.member.id,
      organizationId: s.org.id,
    });

    const evil = await call("delete", `/api-tokens/${issued.id}`, cookie).set(
      "Origin",
      "http://evil.example",
    );
    const anonymous = await call(
      "delete",
      `/api-tokens/${issued.id}`,
      undefined,
    );

    expect(evil.status).toBe(403);
    expect(anonymous.status).toBe(401);
    const row = await prisma.apiToken.findUniqueOrThrow({
      where: { id: issued.id },
    });
    expect(row.revokedAt).toBeNull();
  });
});

describe("CR-332 active token cap per user and organization", () => {
  const CAP = MAX_ACTIVE_TOKENS_PER_ORGANIZATION;

  async function seedMany(
    s: Scenario,
    count: number,
    options: Partial<Parameters<typeof seedApiToken>[1]> = {},
  ) {
    for (let index = 0; index < count; index += 1) {
      await seedApiToken(prisma, {
        userId: s.member.id,
        organizationId: s.org.id,
        scopes: ["invoices:read"],
        ...options,
      });
    }
  }

  it("answers 409 TOKEN_LIMIT at the cap and creates nothing", async () => {
    const { s, cookie } = await flaggedScenario();
    await seedMany(s, CAP);

    const response = await emit(cookie, requestBody(s));

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("TOKEN_LIMIT");
    expect(response.body.error.message).not.toMatch(/iop_/);
    expect(await tokenRows(s.member.id)).toHaveLength(CAP);
  });

  it("does not count revoked or expired tokens and is per user", async () => {
    const { s, cookie } = await flaggedScenario();
    await seedMany(s, CAP - 1);
    await seedMany(s, 5, { revokedAt: new Date() });
    await seedMany(s, 5, {
      createdAt: new Date(Date.now() - 2 * DAY_MS),
      expiresAt: new Date(Date.now() - 1000),
    });

    expect((await emit(cookie, requestBody(s))).status).toBe(201);
    const full = await emit(cookie, requestBody(s));
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("TOKEN_LIMIT");

    // Another user of the same organization has an empty budget.
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: { userId: s.admin.id, organizationId: s.org.id },
      },
      data: { ...NO_FLAGS, readInvoices: true },
    });
    const adminCookie = await cookieFor(s.admin);
    expect((await emit(adminCookie, requestBody(s))).status).toBe(201);
  });

  it("frees a slot when one token is revoked through the API", async () => {
    const { s, cookie } = await flaggedScenario();
    await seedMany(s, CAP - 1);
    const first = await emit(cookie, requestBody(s));
    expect(first.status).toBe(201);
    expect((await emit(cookie, requestBody(s))).status).toBe(409);

    expect(
      (await call("delete", `/api-tokens/${first.body.token.id}`, cookie))
        .status,
    ).toBe(204);

    expect((await emit(cookie, requestBody(s))).status).toBe(201);
  });

  it("never exceeds the cap under concurrent emissions", async () => {
    const { s, cookie } = await flaggedScenario();
    await seedMany(s, CAP - 2);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        emit(cookie, requestBody(s)).then((r) => r),
      ),
    );

    const created = responses.filter((r) => r.status === 201);
    const refused = responses.filter((r) => r.status === 409);
    expect(created).toHaveLength(2);
    expect(refused).toHaveLength(4);
    for (const r of refused) expect(r.body.error.code).toBe("TOKEN_LIMIT");
    expect(
      await prisma.apiToken.count({
        where: { userId: s.member.id, revokedAt: null },
      }),
    ).toBe(CAP);
  });
});

describe("RP0-16 emission races a password change (AC-10)", () => {
  it("never leaves an active token behind a rotated session", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { s, cookie } = await flaggedScenario();

      const [emitted, changed] = await Promise.all([
        emit(cookie, requestBody(s)).then((response) => response),
        call("post", "/auth/change-password", cookie, {
          currentPassword: PASSWORD,
          newPassword: `another-password-${round}-${randomUUID()}`,
        }).then((response) => response),
      ]);

      expect(changed.status).toBe(204);
      // Emitted before the rotation (then revoked by it) or refused by it.
      expect([201, 401]).toContain(emitted.status);
      const rows = await tokenRows(s.member.id);
      expect(rows).toHaveLength(emitted.status === 201 ? 1 : 0);
      for (const row of rows) expect(row.revokedAt).toBeInstanceOf(Date);
      if (emitted.status === 201) {
        const refused = await bearerCall(
          app,
          "get",
          `/invoices?organizationId=${s.org.id}`,
          emitted.body.secret,
        );
        expect(refused.status).toBe(401);
      }
    }
  });
});
