import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import {
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
const CREATE_ONLY = { ...NO_FLAGS, createInvoices: true };

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

function body(
  s: Scenario,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    organizationId: s.org.id,
    groupId: s.group.id,
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

function orgScoped(s: Scenario, overrides: Record<string, unknown> = {}) {
  const payload = body(s, overrides);
  delete payload.groupId;
  return payload;
}

function create(
  cookie: string | undefined,
  payload: unknown,
  key: string | null = newKey(),
) {
  const test = call("post", "/invoices", cookie, payload);
  return key === null ? test : test.set("Idempotency-Key", key);
}

const orgFlagsPath = (s: Scenario, userId: string) =>
  `/organizations/${s.org.id}/memberships/${userId}/permissions`;
const groupFlagsPath = (s: Scenario, userId: string) =>
  `/organizations/${s.org.id}/groups/${s.group.id}/memberships/${userId}/permissions`;

const invoiceCount = (organizationId: string) =>
  prisma.invoice.count({ where: { organizationId } });
const recordCount = (organizationId: string) =>
  prisma.invoiceIdempotencyRecord.count({ where: { organizationId } });

async function createdScenario(flags = CREATE_ONLY) {
  const s = await scenario();
  await prisma.organizationMembership.update({
    where: {
      userId_organizationId: { userId: s.member.id, organizationId: s.org.id },
    },
    data: flags,
  });
  return { s, cookie: await cookieFor(s.member) };
}

describe("RP0-09/10 POST /api/v1/invoices creation (AC-01)", () => {
  it.each(["group", "organization"] as const)(
    "creates a %s-scoped invoice stored exactly as sent",
    async (scope) => {
      const { s, cookie } = await createdScenario();
      const payload = scope === "group" ? body(s) : orgScoped(s);

      const response = await create(cookie, payload);

      expect(response.status).toBe(201);
      const invoice = response.body.invoice;
      expect(invoice).toMatchObject({
        organizationId: s.org.id,
        groupId: scope === "group" ? s.group.id : null,
        businessId: payload.businessId,
        amountPesos: 12500,
        currency: "CLP",
        issuedOn: "2026-10-25",
        dueOn: "2026-11-25",
        businessStatus: "PENDING",
        processingStatus: "NOT_REQUESTED",
        createdByUserId: s.member.id,
      });
      expect(response.headers.location).toBe(
        `/api/v1/invoices/${invoice.id}?organizationId=${s.org.id}` +
          (scope === "group" ? `&groupId=${s.group.id}` : ""),
      );
      expect(response.headers["idempotency-replayed"]).toBeUndefined();

      const row = await prisma.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
      });
      expect(row).toMatchObject({
        amountPesos: 12500,
        scopeKey: scope === "group" ? s.group.id : "organization",
        groupId: scope === "group" ? s.group.id : null,
        processingStatus: "NOT_REQUESTED",
        createdByUserId: s.member.id,
        deletedAt: null,
      });
      // The DATE columns hold the civil date, with no timezone shift.
      const stored = await client.query(
        'SELECT "issuedOn"::text AS issued, "dueOn"::text AS due FROM "Invoice" WHERE id = $1',
        [invoice.id],
      );
      expect(stored.rows[0]).toEqual({
        issued: "2026-10-25",
        due: "2026-11-25",
      });
    },
  );

  it("accepts an explicit null groupId as the organization scope", async () => {
    const { s, cookie } = await createdScenario();
    const response = await create(cookie, body(s, { groupId: null }));

    expect(response.status).toBe(201);
    expect(response.body.invoice.groupId).toBeNull();
  });
});

describe("RP0-09/10 create authorization (AC-02, AC-03, AC-05)", () => {
  it("lets organization-level create cover the organization and any group", async () => {
    const { s, cookie } = await createdScenario();
    const other = await makeGroup(s.org.id, "Other");

    expect((await create(cookie, orgScoped(s))).status).toBe(201);
    expect((await create(cookie, body(s))).status).toBe(201);
    expect((await create(cookie, body(s, { groupId: other.id }))).status).toBe(
      201,
    );
  });

  it("limits group-level create to that group", async () => {
    const { s, cookie } = await createdScenario(NO_FLAGS);
    const other = await makeGroup(s.org.id, "Other");
    await addToGroup(s.group.id, s.member.id, s.org.id, CREATE_ONLY);

    expect((await create(cookie, body(s))).status).toBe(201);
    const foreignGroup = await create(cookie, body(s, { groupId: other.id }));
    const organization = await create(cookie, orgScoped(s));
    expect(foreignGroup.status).toBe(403);
    expect(organization.status).toBe(403);
    expect(foreignGroup.body.error.code).toBe("FORBIDDEN");
    expect(await invoiceCount(s.org.id)).toBe(1);
  });

  it("does not need read to create, and an ADMIN without the flag is forbidden", async () => {
    const { s, cookie } = await createdScenario(CREATE_ONLY);
    expect((await create(cookie, orgScoped(s))).status).toBe(201);

    const adminCookie = await cookieFor(s.admin);
    const denied = await create(adminCookie, orgScoped(s));
    expect(denied.status).toBe(403);
    expect(await invoiceCount(s.org.id)).toBe(1);
  });

  it("answers 404 to the platform administrator without a membership", async () => {
    const s = await scenario();
    const response = await create(platformCookie, orgScoped(s));

    expect(response.status).toBe(404);
    expect(await invoiceCount(s.org.id)).toBe(0);
  });

  it("answers 404 for a foreign or nonexistent organization and a foreign group", async () => {
    const { s, cookie } = await createdScenario();
    const foreign = await scenario();
    const foreignGroup = await makeGroup(foreign.org.id, "Foreign");

    for (const payload of [
      orgScoped(foreign),
      body(s, { organizationId: MISSING, groupId: null }),
      body(s, { groupId: foreignGroup.id }),
      body(s, { groupId: MISSING }),
    ]) {
      const response = await create(cookie, payload);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    }
    expect(await invoiceCount(s.org.id)).toBe(0);
    expect(await invoiceCount(foreign.org.id)).toBe(0);
  });

  it("answers 403 in a disabled organization", async () => {
    const { s, cookie } = await createdScenario();
    await prisma.organization.update({
      where: { id: s.org.id },
      data: { enabled: false },
    });

    const response = await create(cookie, orgScoped(s));

    expect(response.status).toBe(403);
    expect(await invoiceCount(s.org.id)).toBe(0);
  });
});

describe("RP0-09/10 validation writes nothing (AC-04, AC-06)", () => {
  it("persists no row for invalid bodies or keys", async () => {
    const { s, cookie } = await createdScenario();

    const invalidBodies = [
      body(s, { amountPesos: 0 }),
      body(s, { amountPesos: 1.5 }),
      body(s, { currency: "USD" }),
      body(s, { dueOn: "2026-10-24" }),
      body(s, { issuedOn: "2026-02-30" }),
      body(s, { id: randomUUID() }),
      body(s, { unexpected: true }),
    ];
    for (const payload of invalidBodies) {
      expect((await create(cookie, payload)).status).toBe(400);
    }
    for (const key of [
      null,
      "short",
      "a".repeat(129),
      "has spaces in the key",
    ]) {
      expect((await create(cookie, body(s), key)).status).toBe(400);
    }

    expect(await invoiceCount(s.org.id)).toBe(0);
    expect(await recordCount(s.org.id)).toBe(0);
  });
});

describe("RP0-09/10 idempotent replay (AC-07, AC-08, AC-09, AC-11)", () => {
  it.each(["group", "organization"] as const)(
    "replays the identical 201 in %s scope without duplicating",
    async (scope) => {
      const { s, cookie } = await createdScenario();
      const payload = scope === "group" ? body(s) : orgScoped(s);
      const key = newKey();

      const first = await create(cookie, payload, key);
      const second = await create(cookie, payload, key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body).toEqual(first.body);
      expect(second.headers.location).toBe(first.headers.location);
      expect(second.headers["idempotency-replayed"]).toBe("true");
      expect(await invoiceCount(s.org.id)).toBe(1);
      expect(await recordCount(s.org.id)).toBe(1);
    },
  );

  it("answers 409 IDEMPOTENCY_CONFLICT when the same key carries another body", async () => {
    const { s, cookie } = await createdScenario();
    const payload = body(s);
    const key = newKey();
    await create(cookie, payload, key);

    const changed = await create(
      cookie,
      { ...payload, amountPesos: 12501 },
      key,
    );

    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(changed.body.invoice).toBeUndefined();
    expect(await invoiceCount(s.org.id)).toBe(1);
  });

  it("answers 409 when the same key and businessId move to another scope", async () => {
    const { s, cookie } = await createdScenario();
    const payload = body(s);
    const key = newKey();
    await create(cookie, payload, key);

    // The scope is part of the idempotency key, so the organization scope is
    // a different record; the repeated businessId is what collides.
    const moved = await create(cookie, { ...payload, groupId: null }, key);

    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe("BUSINESS_ID_CONFLICT");
    expect(await invoiceCount(s.org.id)).toBe(1);
  });

  it("answers 409 BUSINESS_ID_CONFLICT for another key with a repeated businessId, across scopes", async () => {
    const { s, cookie } = await createdScenario();
    const payload = body(s);
    await create(cookie, payload);

    const sameScope = await create(cookie, payload);
    const otherScope = await create(cookie, { ...payload, groupId: null });

    for (const response of [sameScope, otherScope]) {
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("BUSINESS_ID_CONFLICT");
    }
    expect(await invoiceCount(s.org.id)).toBe(1);
    expect(await recordCount(s.org.id)).toBe(1);
  });

  it("keeps the same key independent across scopes", async () => {
    const { s, cookie } = await createdScenario();
    const other = await makeGroup(s.org.id, "Other");
    const key = newKey();

    const results = [
      await create(cookie, orgScoped(s), key),
      await create(cookie, body(s), key),
      await create(cookie, body(s, { groupId: other.id }), key),
    ];

    for (const response of results) {
      expect(response.status).toBe(201);
      expect(response.headers["idempotency-replayed"]).toBeUndefined();
    }
    expect(new Set(results.map((r) => r.body.invoice.id)).size).toBe(3);
    expect(await recordCount(s.org.id)).toBe(3);
  });

  it("keeps the same key independent across users", async () => {
    const { s, cookie } = await createdScenario();
    const second = await makeUser("Second Creator");
    await join(second.id, s.org.id, "USER", CREATE_ONLY);
    const secondCookie = await cookieFor(second);
    const key = newKey();

    const mine = await create(cookie, orgScoped(s), key);
    const theirs = await create(secondCookie, orgScoped(s), key);

    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(mine.body.invoice.id).not.toBe(theirs.body.invoice.id);
  });

  it("answers 410 INVOICE_DELETED for a replay of a deleted invoice and does not restore it", async () => {
    const { s, cookie } = await createdScenario();
    const payload = orgScoped(s);
    const key = newKey();
    const first = await create(cookie, payload, key);
    const deletedAt = new Date();
    await prisma.invoice.update({
      where: { id: first.body.invoice.id },
      data: { deletedAt, deletedByUserId: s.member.id },
    });

    const replay = await create(cookie, payload, key);

    expect(replay.status).toBe(410);
    expect(replay.body.error.code).toBe("INVOICE_DELETED");
    expect(replay.body.invoice).toBeUndefined();
    const row = await prisma.invoice.findUniqueOrThrow({
      where: { id: first.body.invoice.id },
    });
    expect(row.deletedAt).toEqual(deletedAt);
    expect(await invoiceCount(s.org.id)).toBe(1);
    // The businessId of a deleted invoice stays reserved.
    const reuse = await create(cookie, payload);
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("BUSINESS_ID_CONFLICT");
  });
});

describe("RP0-09/10 revocation is checked before any replay (AC-10)", () => {
  it("answers 403 without a snapshot after the organization flag is revoked", async () => {
    const { s, cookie } = await createdScenario();
    const payload = orgScoped(s);
    const key = newKey();
    expect((await create(cookie, payload, key)).status).toBe(201);
    const adminCookie = await cookieFor(s.admin);

    const revoke = await call(
      "put",
      orgFlagsPath(s, s.member.id),
      adminCookie,
      { permissions: NO_FLAGS },
    );
    expect(revoke.status).toBe(200);

    const replay = await create(cookie, payload, key);
    expect(replay.status).toBe(403);
    expect(replay.body.invoice).toBeUndefined();
    expect(JSON.stringify(replay.body)).not.toContain(payload.businessId);
  });

  it("answers 403 without a snapshot after the group flag is revoked", async () => {
    const { s, cookie } = await createdScenario(NO_FLAGS);
    await addToGroup(s.group.id, s.member.id, s.org.id, CREATE_ONLY);
    const payload = body(s);
    const key = newKey();
    expect((await create(cookie, payload, key)).status).toBe(201);
    const adminCookie = await cookieFor(s.admin);

    const revoke = await call(
      "put",
      groupFlagsPath(s, s.member.id),
      adminCookie,
      { permissions: NO_FLAGS },
    );
    expect(revoke.status).toBe(200);

    const replay = await create(cookie, payload, key);
    expect(replay.status).toBe(403);
    expect(replay.body.invoice).toBeUndefined();
  });

  it("answers 404 without a snapshot after the membership is removed", async () => {
    const { s, cookie } = await createdScenario();
    const payload = orgScoped(s);
    const key = newKey();
    expect((await create(cookie, payload, key)).status).toBe(201);
    const adminCookie = await cookieFor(s.admin);

    const removal = await call(
      "delete",
      `/organizations/${s.org.id}/memberships/${s.member.id}`,
      adminCookie,
    );
    expect(removal.status).toBe(204);

    const replay = await create(cookie, payload, key);
    expect(replay.status).toBe(404);
    expect(replay.body.invoice).toBeUndefined();
  });

  it("does not reveal a deleted invoice to a revoked actor", async () => {
    const { s, cookie } = await createdScenario();
    const payload = orgScoped(s);
    const key = newKey();
    const first = await create(cookie, payload, key);
    await prisma.invoice.update({
      where: { id: first.body.invoice.id },
      data: { deletedAt: new Date(), deletedByUserId: s.member.id },
    });
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
      data: NO_FLAGS,
    });

    expect((await create(cookie, payload, key)).status).toBe(403);
  });
});

describe("RP0-09/10 concurrency (AC-12)", () => {
  it("lets 8 identical concurrent requests create one invoice and one record", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { s, cookie } = await createdScenario();
      const payload = body(s);
      const key = newKey();

      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          create(cookie, payload, key).then((response) => response),
        ),
      );

      const statuses = responses.map((response) => response.status);
      // Bounded retries may exhaust under contention: the documented 503.
      for (const status of statuses) expect([201, 503]).toContain(status);
      const created = responses.filter(
        (r) =>
          r.status === 201 && r.headers["idempotency-replayed"] === undefined,
      );
      const replayed = responses.filter(
        (r) => r.status === 201 && r.headers["idempotency-replayed"] === "true",
      );
      expect(created).toHaveLength(1);
      expect(created.length + replayed.length).toBeGreaterThan(0);
      for (const response of [...created, ...replayed]) {
        expect(response.body).toEqual(created[0].body);
      }
      for (const response of responses.filter((r) => r.status === 503)) {
        expect(response.body.error.code).toBe("RETRYABLE_CONFLICT");
        expect(response.headers["retry-after"]).toBeDefined();
      }
      expect(await invoiceCount(s.org.id)).toBe(1);
      expect(await recordCount(s.org.id)).toBe(1);
    }
  });

  it("lets one of several different keys with the same businessId win", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { s, cookie } = await createdScenario();
      const businessId = `FAC-${randomUUID()}`;

      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          create(cookie, body(s, { businessId })).then((response) => response),
        ),
      );

      const created = responses.filter((r) => r.status === 201);
      expect(created).toHaveLength(1);
      for (const response of responses.filter((r) => r.status !== 201)) {
        expect([409, 503]).toContain(response.status);
        expect(["BUSINESS_ID_CONFLICT", "RETRYABLE_CONFLICT"]).toContain(
          response.body.error.code,
        );
      }
      expect(await invoiceCount(s.org.id)).toBe(1);
      // No orphan records: every record points to the one stored invoice.
      expect(await recordCount(s.org.id)).toBe(1);
    }
  });

  it("creates distinct invoices for distinct keys and businessIds in parallel", async () => {
    const { s, cookie } = await createdScenario();

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => create(cookie, body(s)).then((r) => r)),
    );

    // Independent creates never conflict by business rule: the only accepted
    // alternative to 201 is a retryable 503 (SERIALIZABLE may still abort a
    // transaction on index-page predicate locks, so not all six are required
    // to succeed), and never a 4xx. At least one must be created, so the test
    // cannot pass vacuously when everything answers 503.
    const created = responses.filter((r) => r.status === 201);
    for (const response of responses.filter((r) => r.status !== 201)) {
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("RETRYABLE_CONFLICT");
      expect(response.headers["retry-after"]).toBeDefined();
    }
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(await invoiceCount(s.org.id)).toBe(created.length);
    expect(await recordCount(s.org.id)).toBe(created.length);
  });
});

describe("RP0-09/10 permission change races (AC-13, CR-103, CR-208)", () => {
  it("makes a create wait for a revoking change and then answer 403", async () => {
    const { s, cookie } = await createdScenario();
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        'SELECT id FROM "OrganizationMembership" WHERE "userId" = $1 AND "organizationId" = $2 FOR UPDATE',
        [s.member.id, s.org.id],
      );
      await holder.query(
        'UPDATE "OrganizationMembership" SET "createInvoices" = false WHERE "userId" = $1 AND "organizationId" = $2',
        [s.member.id, s.org.id],
      );

      const pending = create(cookie, orgScoped(s)).then((response) => response);
      await waitUntilBlocked('%FROM "OrganizationMembership"%FOR SHARE%');
      await holder.query("COMMIT");

      const response = await pending;
      expect(response.status).toBe(403);
      expect(await invoiceCount(s.org.id)).toBe(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("makes a revoking change wait for an in-flight create and then apply", async () => {
    const { s, cookie } = await createdScenario();
    const adminCookie = await cookieFor(s.admin);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        'SELECT id FROM "OrganizationMembership" WHERE "userId" = $1 AND "organizationId" = $2 FOR SHARE',
        [s.member.id, s.org.id],
      );

      const revoke = call("put", orgFlagsPath(s, s.member.id), adminCookie, {
        permissions: NO_FLAGS,
      }).then((response) => response);
      await waitUntilBlocked('%FROM "OrganizationMembership"%FOR UPDATE%');
      await holder.query("COMMIT");

      expect((await revoke).status).toBe(200);
      expect((await create(cookie, orgScoped(s))).status).toBe(403);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("never leaves a created invoice behind a revoked, unreplayable state inconsistently", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { s, cookie } = await createdScenario();
      const adminCookie = await cookieFor(s.admin);
      const payload = orgScoped(s);
      const key = newKey();

      const [created, revoke] = await Promise.all([
        create(cookie, payload, key).then((response) => response),
        call("put", orgFlagsPath(s, s.member.id), adminCookie, {
          permissions: NO_FLAGS,
        }).then((response) => response),
      ]);

      expect(revoke.status).toBe(200);
      // Serialized one way or the other: created before the revocation, or
      // forbidden by it; never an invoice with a 403 or the reverse.
      expect([201, 403]).toContain(created.status);
      expect(await invoiceCount(s.org.id)).toBe(created.status === 201 ? 1 : 0);
      const replay = await create(cookie, payload, key);
      expect(replay.status).toBe(403);
      expect(replay.body.invoice).toBeUndefined();
    }
  });

  it("serializes a create against the removal of the membership", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { s, cookie } = await createdScenario();
      const adminCookie = await cookieFor(s.admin);

      const [created, removal] = await Promise.all([
        create(cookie, orgScoped(s)).then((response) => response),
        call(
          "delete",
          `/organizations/${s.org.id}/memberships/${s.member.id}`,
          adminCookie,
        ).then((response) => response),
      ]);

      expect(removal.status).toBe(204);
      expect([201, 404]).toContain(created.status);
      expect(await invoiceCount(s.org.id)).toBe(created.status === 201 ? 1 : 0);
    }
  });
});

describe("RP0-09/10 no external calls (AC-14)", () => {
  it("does not call fetch while creating or replaying", async () => {
    const { s, cookie } = await createdScenario();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const payload = orgScoped(s);
      const key = newKey();
      expect((await create(cookie, payload, key)).status).toBe(201);
      expect((await create(cookie, payload, key)).status).toBe(201);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
