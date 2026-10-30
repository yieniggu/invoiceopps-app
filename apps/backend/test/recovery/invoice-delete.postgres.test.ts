import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

// RP0-12: logical deletion of an invoice (AC-09..AC-13) on real PostgreSQL
// through the real HTTP app. The InvoiceEvent table is read with raw SQL so
// the suite does not depend on the generated client for assertions.

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
const DELETE_OWN = { ...NO_FLAGS, deleteOwnInvoices: true };
const DELETE_OTHERS = { ...NO_FLAGS, deleteOthersInvoices: true };
const DELETE_BOTH = { ...DELETE_OWN, deleteOthersInvoices: true };
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";

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

/** Inserts an invoice row directly; deletion never depends on the create path. */
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

function remove(
  cookie: string | undefined,
  s: Scenario,
  invoiceId: string,
  groupId?: string,
) {
  const query = new URLSearchParams({ organizationId: s.org.id });
  if (groupId) query.set("groupId", groupId);
  return call("delete", `/invoices/${invoiceId}?${query.toString()}`, cookie);
}

const detailPath = (s: Scenario, invoiceId: string) =>
  `/invoices/${invoiceId}?organizationId=${s.org.id}`;

interface EventRow {
  id: string;
  invoiceId: string;
  type: string;
  actorUserId: string;
  organizationId: string;
  groupId: string | null;
  createdAt: Date;
}

async function eventsOf(invoiceId: string) {
  const result = await client.query(
    'SELECT * FROM "InvoiceEvent" WHERE "invoiceId" = $1',
    [invoiceId],
  );
  return result.rows as unknown as EventRow[];
}

async function eventCount(organizationId: string) {
  const result = await client.query(
    'SELECT count(*)::int AS n FROM "InvoiceEvent" WHERE "organizationId" = $1',
    [organizationId],
  );
  return result.rows[0].n as number;
}

const stored = (invoiceId: string) =>
  prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });

const orgFlagsPath = (s: Scenario, userId: string) =>
  `/organizations/${s.org.id}/memberships/${userId}/permissions`;
const groupFlagsPath = (s: Scenario, userId: string) =>
  `/organizations/${s.org.id}/groups/${s.group.id}/memberships/${userId}/permissions`;

/** A scenario whose member holds the given organization flags. */
async function world(flags = DELETE_BOTH) {
  const s = await scenario();
  await prisma.organizationMembership.update({
    where: {
      userId_organizationId: { userId: s.member.id, organizationId: s.org.id },
    },
    data: flags,
  });
  return { s, cookie: await cookieFor(s.member) };
}

describe("RP0-12 DELETE authorization by author and flag (AC-09)", () => {
  it("lets deleteOwn delete an own invoice and forbids another one", async () => {
    const { s, cookie } = await world(DELETE_OWN);
    const own = await seed(s.org.id, s.member.id);
    const foreign = await seed(s.org.id, s.admin.id);

    const denied = await remove(cookie, s, foreign.id);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");
    expect((await stored(foreign.id)).deletedAt).toBeNull();

    const allowed = await remove(cookie, s, own.id);
    expect(allowed.status).toBe(204);
    expect((await stored(own.id)).deletedAt).not.toBeNull();
  });

  it("lets deleteOthers delete another invoice and forbids an own one when deleteOwn is off", async () => {
    const { s, cookie } = await world(DELETE_OTHERS);
    const own = await seed(s.org.id, s.member.id);
    const foreign = await seed(s.org.id, s.admin.id);

    expect((await remove(cookie, s, own.id)).status).toBe(403);
    expect((await stored(own.id)).deletedAt).toBeNull();
    expect((await remove(cookie, s, foreign.id)).status).toBe(204);
    expect((await stored(foreign.id)).deletedAt).not.toBeNull();
  });

  it("does not need read or create, and records the actor on the invoice", async () => {
    const { s, cookie } = await world({ ...DELETE_OWN, readInvoices: false });
    const own = await seed(s.org.id, s.member.id);

    expect((await remove(cookie, s, own.id)).status).toBe(204);
    const row = await stored(own.id);
    expect(row.deletedByUserId).toBe(s.member.id);
    expect(row.deletedAt).toBeInstanceOf(Date);
  });

  it("does not let read or create imply deletion, nor the ADMIN role", async () => {
    const { s, cookie } = await world({
      ...NO_FLAGS,
      readInvoices: true,
      createInvoices: true,
    });
    const own = await seed(s.org.id, s.member.id);
    const adminCookie = await cookieFor(s.admin);

    expect((await remove(cookie, s, own.id)).status).toBe(403);
    expect((await remove(adminCookie, s, own.id)).status).toBe(403);
    expect((await stored(own.id)).deletedAt).toBeNull();
    expect(await eventCount(s.org.id)).toBe(0);
  });

  it("answers 404 to the platform administrator without a membership", async () => {
    const { s } = await world();
    const invoice = await seed(s.org.id, s.member.id);

    const response = await remove(platformCookie, s, invoice.id);
    expect(response.status).toBe(404);
    expect((await stored(invoice.id)).deletedAt).toBeNull();
  });

  it("answers 403 when the organization is disabled", async () => {
    const { s, cookie } = await world();
    const invoice = await seed(s.org.id, s.member.id);
    await prisma.organization.update({
      where: { id: s.org.id },
      data: { enabled: false },
    });

    expect((await remove(cookie, s, invoice.id)).status).toBe(403);
    expect((await stored(invoice.id)).deletedAt).toBeNull();
  });

  it("resolves group invoices with organization OR group flags", async () => {
    const { s, cookie } = await world(NO_FLAGS);
    await addToGroup(s.group.id, s.member.id, s.org.id, DELETE_OWN);
    const own = await seed(s.org.id, s.member.id, s.group.id);
    const foreign = await seed(s.org.id, s.admin.id, s.group.id);

    // The group flag covers an own invoice and not another one.
    expect((await remove(cookie, s, foreign.id)).status).toBe(403);
    expect((await remove(cookie, s, own.id)).status).toBe(204);

    // Granting deleteOthers at organization level now covers the group too.
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
      data: DELETE_OTHERS,
    });
    expect((await remove(cookie, s, foreign.id)).status).toBe(204);
  });

  it("does not use organization-scope group flags for an organization invoice", async () => {
    const { s, cookie } = await world(NO_FLAGS);
    await addToGroup(s.group.id, s.member.id, s.org.id, DELETE_BOTH);
    const orgInvoice = await seed(s.org.id, s.member.id);

    const response = await remove(cookie, s, orgInvoice.id);
    expect(response.status).toBe(403);
    expect((await stored(orgInvoice.id)).deletedAt).toBeNull();
  });

  it("resolves the permission with the real group of the invoice, not the one in the query", async () => {
    const { s, cookie } = await world(NO_FLAGS);
    const other = await makeGroup(s.org.id, "Other");
    await addToGroup(s.group.id, s.member.id, s.org.id, DELETE_BOTH);
    const inOther = await seed(s.org.id, s.member.id, other.id);

    // The actor can delete in s.group but the invoice lives in the other group.
    const mismatch = await remove(cookie, s, inOther.id, s.group.id);
    expect(mismatch.status).toBe(404);
    const noContext = await remove(cookie, s, inOther.id);
    expect(noContext.status).toBe(404);
    expect((await stored(inOther.id)).deletedAt).toBeNull();
  });

  it("accepts a matching groupId context", async () => {
    const { s, cookie } = await world();
    const invoice = await seed(s.org.id, s.member.id, s.group.id);

    expect((await remove(cookie, s, invoice.id, s.group.id)).status).toBe(204);
  });
});

describe("RP0-12 visibility: 404 versus 403 (AC-09)", () => {
  it("answers the same 404 body for missing, foreign, mismatched and invisible invoices", async () => {
    const { s, cookie } = await world(NO_FLAGS);
    const foreignWorld = await world();
    const foreignInvoice = await seed(
      foreignWorld.s.org.id,
      foreignWorld.s.member.id,
    );
    const hidden = await seed(s.org.id, s.admin.id, s.group.id);
    const orgInvoice = await seed(s.org.id, s.admin.id);
    const other = await makeGroup(s.org.id, "Other");

    const responses = [
      await remove(cookie, s, MISSING),
      await remove(cookie, s, foreignInvoice.id),
      await remove(cookie, s, hidden.id),
      await remove(cookie, s, orgInvoice.id, other.id),
      await remove(cookie, s, "not-a-uuid-at-all"),
      await call(
        "delete",
        `/invoices/${hidden.id}?organizationId=${MISSING}`,
        cookie,
      ),
    ];

    // The organization invoice is in scope for an organization member: 403.
    const [missing, foreign, invisible, mismatch, junk, noOrg] = responses;
    for (const response of [missing, foreign, invisible, junk, noOrg]) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual(missing.body);
    }
    expect(mismatch.status).toBe(404);
    expect(mismatch.body).toEqual(missing.body);
    expect((await stored(hidden.id)).deletedAt).toBeNull();
  });

  it("answers 403 for an organization member in scope without the flag", async () => {
    const { s, cookie } = await world(NO_FLAGS);
    const orgInvoice = await seed(s.org.id, s.admin.id);

    const response = await remove(cookie, s, orgInvoice.id);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("hides a group invoice from a non-member without organization read or the applicable flag", async () => {
    const { s, cookie } = await world(DELETE_OTHERS);
    const own = await seed(s.org.id, s.member.id, s.group.id);

    // Only deleteOthers is granted and the invoice is own: not applicable.
    const response = await remove(cookie, s, own.id);
    expect(response.status).toBe(404);
    expect((await stored(own.id)).deletedAt).toBeNull();
  });

  it("answers 403 for a non-member with organization read but no applicable flag", async () => {
    const { s, cookie } = await world({ ...NO_FLAGS, readInvoices: true });
    const invoice = await seed(s.org.id, s.admin.id, s.group.id);

    expect((await remove(cookie, s, invoice.id)).status).toBe(403);
  });

  it("deletes a group invoice for a non-member holding the applicable organization flag without read", async () => {
    const { s, cookie } = await world(DELETE_OTHERS);
    const invoice = await seed(s.org.id, s.admin.id, s.group.id);

    expect((await remove(cookie, s, invoice.id)).status).toBe(204);
  });

  it.each([
    ["a NUL byte", "%00"],
    ["a non-uuid string", "not-a-uuid"],
  ])(
    "answers the same 404 body for an invoiceId that is %s (CR-327)",
    async (_label, id) => {
      const { s, cookie } = await world();
      const unknown = await remove(cookie, s, MISSING);
      const response = await call(
        "delete",
        `/invoices/${id}?organizationId=${s.org.id}`,
        cookie,
      );

      expect(response.status).toBe(404);
      expect(response.body).toEqual(unknown.body);
    },
  );

  it("answers 401 without a session and 400 for a malformed query, changing nothing", async () => {
    const { s } = await world();
    const invoice = await seed(s.org.id, s.member.id);

    expect((await remove(undefined, s, invoice.id)).status).toBe(401);
    const bad = await call(
      "delete",
      `/invoices/${invoice.id}?organizationId=nope`,
      await cookieFor(s.member),
    );
    expect(bad.status).toBe(400);
    expect((await stored(invoice.id)).deletedAt).toBeNull();
  });
});

describe("RP0-12 logical deletion keeps history and is idempotent (AC-10, AC-11)", () => {
  it("marks the invoice, keeps its data and creator, and records exactly one event", async () => {
    const { s, cookie } = await world();
    const invoice = await seed(s.org.id, s.member.id, s.group.id);

    const response = await remove(cookie, s, invoice.id);

    expect(response.status).toBe(204);
    expect(response.text ?? "").toBe("");
    const row = await stored(invoice.id);
    expect(row).toMatchObject({
      id: invoice.id,
      businessId: invoice.businessId,
      createdByUserId: s.member.id,
      deletedByUserId: s.member.id,
      groupId: s.group.id,
      amountPesos: 12500,
    });
    expect(row.deletedAt).toBeInstanceOf(Date);

    const events = await eventsOf(invoice.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      invoiceId: invoice.id,
      type: "INVOICE_DELETED",
      actorUserId: s.member.id,
      organizationId: s.org.id,
      groupId: s.group.id,
    });
    expect(events[0].id).toEqual(expect.any(String));
    expect(events[0].createdAt).toBeInstanceOf(Date);
  });

  it("stamps the tombstone and the event with the same instant (CR-331)", async () => {
    const { s, cookie } = await world();
    const invoice = await seed(s.org.id, s.member.id, s.group.id);

    expect((await remove(cookie, s, invoice.id)).status).toBe(204);

    // Compared in SQL: node-postgres and Prisma parse TIMESTAMP (without time
    // zone) differently on a non-UTC host, so mixing both readers shifts one.
    const result = await client.query(
      `SELECT i."deletedAt"::text AS "deletedAt", e."createdAt"::text AS "createdAt"
         FROM "Invoice" i JOIN "InvoiceEvent" e ON e."invoiceId" = i.id
        WHERE i.id = $1`,
      [invoice.id],
    );
    const rows = result.rows as unknown as {
      deletedAt: string | null;
      createdAt: string;
    }[];
    expect(rows).toHaveLength(1);
    const [{ deletedAt, createdAt }] = rows;
    expect(deletedAt).not.toBeNull();
    expect(createdAt).toBe(deletedAt);
  });

  it("records a null groupId for an organization invoice", async () => {
    const { s, cookie } = await world();
    const invoice = await seed(s.org.id, s.member.id);

    expect((await remove(cookie, s, invoice.id)).status).toBe(204);
    const [event] = await eventsOf(invoice.id);
    expect(event.groupId).toBeNull();
  });

  it("answers 204 twice with one event and an unchanged tombstone", async () => {
    const { s, cookie } = await world();
    const invoice = await seed(s.org.id, s.member.id);

    expect((await remove(cookie, s, invoice.id)).status).toBe(204);
    const first = await stored(invoice.id);
    expect((await remove(cookie, s, invoice.id)).status).toBe(204);
    const second = await stored(invoice.id);

    expect(second.deletedAt).toEqual(first.deletedAt);
    expect(second.deletedByUserId).toBe(first.deletedByUserId);
    expect(await eventsOf(invoice.id)).toHaveLength(1);
  });

  it("keeps the first actor when another authorized actor repeats the delete", async () => {
    const { s, cookie } = await world();
    const second = await makeUser("Second Deleter");
    await join(second.id, s.org.id, "USER", DELETE_OTHERS);
    const invoice = await seed(s.org.id, s.member.id);

    expect((await remove(cookie, s, invoice.id)).status).toBe(204);
    expect((await remove(await cookieFor(second), s, invoice.id)).status).toBe(
      204,
    );

    expect((await stored(invoice.id)).deletedByUserId).toBe(s.member.id);
    const events = await eventsOf(invoice.id);
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(s.member.id);
  });

  it("keeps authorization on a repeat: 403 without the flag and 404 when invisible", async () => {
    const { s, cookie } = await world();
    const invoice = await seed(s.org.id, s.member.id, s.group.id);
    expect((await remove(cookie, s, invoice.id)).status).toBe(204);

    const noFlag = await makeUser("In scope no flag");
    await join(noFlag.id, s.org.id, "USER", {
      ...NO_FLAGS,
      readInvoices: true,
    });
    const hidden = await makeUser("Hidden");
    await join(hidden.id, s.org.id, "USER", NO_FLAGS);

    const forbidden = await remove(await cookieFor(noFlag), s, invoice.id);
    const invisible = await remove(await cookieFor(hidden), s, invoice.id);
    const outsider = await remove(await cookieFor(s.outsider), s, invoice.id);

    expect(forbidden.status).toBe(403);
    expect(invisible.status).toBe(404);
    expect(outsider.status).toBe(404);
    expect(await eventsOf(invoice.id)).toHaveLength(1);
  });

  it("keeps creator, idempotency record and every other invoice untouched", async () => {
    const { s, cookie } = await world({ ...DELETE_BOTH, createInvoices: true });
    const created = await call("post", "/invoices", cookie, {
      organizationId: s.org.id,
      businessId: `FAC-${randomUUID()}`,
      supplierName: "Proveedor local",
      amountPesos: 12500,
      currency: "CLP",
      issuedOn: "2026-10-25",
      dueOn: "2026-11-25",
      businessStatus: "PENDING",
    }).set("Idempotency-Key", newKey());
    expect(created.status).toBe(201);
    const bystander = await seed(s.org.id, s.admin.id);
    const id = created.body.invoice.id as string;

    expect((await remove(cookie, s, id)).status).toBe(204);

    expect(
      await prisma.invoice.count({ where: { organizationId: s.org.id } }),
    ).toBe(2);
    expect(
      await prisma.invoiceIdempotencyRecord.count({
        where: { organizationId: s.org.id, invoiceId: id },
      }),
    ).toBe(1);
    expect((await stored(id)).createdByUserId).toBe(s.member.id);
    expect((await stored(bystander.id)).deletedAt).toBeNull();
    expect(await eventCount(s.org.id)).toBe(1);
  });
});

describe("RP0-12 effects of a deletion on reads and creates (AC-12)", () => {
  it("removes the invoice from the detail and the list", async () => {
    const { s, cookie } = await world({ ...DELETE_BOTH, readInvoices: true });
    const doomed = await seed(s.org.id, s.member.id);
    const kept = await seed(s.org.id, s.member.id);

    expect((await call("get", detailPath(s, doomed.id), cookie)).status).toBe(
      200,
    );
    expect((await remove(cookie, s, doomed.id)).status).toBe(204);

    const detail = await call("get", detailPath(s, doomed.id), cookie);
    expect(detail.status).toBe(404);
    const list = await call(
      "get",
      `/invoices?organizationId=${s.org.id}`,
      cookie,
    );
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([
      kept.id,
    ]);
  });

  it("answers 410 INVOICE_DELETED to a replay and 409 BUSINESS_ID_CONFLICT to a new key", async () => {
    const { s, cookie } = await world({ ...DELETE_BOTH, createInvoices: true });
    const payload = {
      organizationId: s.org.id,
      businessId: `FAC-${randomUUID()}`,
      supplierName: "Proveedor local",
      amountPesos: 12500,
      currency: "CLP",
      issuedOn: "2026-10-25",
      dueOn: "2026-11-25",
      businessStatus: "PENDING",
    };
    const key = newKey();
    const created = await call("post", "/invoices", cookie, payload).set(
      "Idempotency-Key",
      key,
    );
    expect(created.status).toBe(201);
    const id = created.body.invoice.id as string;

    expect((await remove(cookie, s, id)).status).toBe(204);

    const replay = await call("post", "/invoices", cookie, payload).set(
      "Idempotency-Key",
      key,
    );
    expect(replay.status).toBe(410);
    expect(replay.body.error.code).toBe("INVOICE_DELETED");
    expect(replay.body.invoice).toBeUndefined();

    const reuse = await call("post", "/invoices", cookie, payload).set(
      "Idempotency-Key",
      newKey(),
    );
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("BUSINESS_ID_CONFLICT");

    // Not restored, not recreated, no extra event.
    expect((await stored(id)).deletedAt).not.toBeNull();
    expect(
      await prisma.invoice.count({ where: { organizationId: s.org.id } }),
    ).toBe(1);
    expect(await eventsOf(id)).toHaveLength(1);
  });

  it("still requires createInvoices to learn about the deletion on a replay", async () => {
    const { s, cookie } = await world({ ...DELETE_BOTH, createInvoices: true });
    const payload = {
      organizationId: s.org.id,
      businessId: `FAC-${randomUUID()}`,
      supplierName: "Proveedor local",
      amountPesos: 12500,
      currency: "CLP",
      issuedOn: "2026-10-25",
      dueOn: "2026-11-25",
      businessStatus: "PENDING",
    };
    const key = newKey();
    const created = await call("post", "/invoices", cookie, payload).set(
      "Idempotency-Key",
      key,
    );
    const id = created.body.invoice.id as string;
    expect((await remove(cookie, s, id)).status).toBe(204);
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: s.member.id,
          organizationId: s.org.id,
        },
      },
      data: DELETE_BOTH,
    });

    const replay = await call("post", "/invoices", cookie, payload).set(
      "Idempotency-Key",
      key,
    );
    expect(replay.status).toBe(403);
  });
});

describe("InvoiceEvent table expectations (AC-10)", () => {
  it("rejects a second INVOICE_DELETED event for the same invoice", async () => {
    const { s } = await world();
    const invoice = await seed(s.org.id, s.member.id);
    const insert = () =>
      client.query(
        `INSERT INTO "InvoiceEvent" ("id","invoiceId","type","actorUserId","organizationId")
         VALUES ($1,$2,'INVOICE_DELETED',$3,$4)`,
        [randomUUID(), invoice.id, s.member.id, s.org.id],
      );

    await insert();
    await expect(insert()).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    expect(await eventsOf(invoice.id)).toHaveLength(1);
  });

  it("restricts deleting an invoice that has an event", async () => {
    const { s } = await world();
    const invoice = await seed(s.org.id, s.member.id);
    await client.query(
      `INSERT INTO "InvoiceEvent" ("id","invoiceId","type","actorUserId","organizationId")
       VALUES ($1,$2,'INVOICE_DELETED',$3,$4)`,
      [randomUUID(), invoice.id, s.member.id, s.org.id],
    );

    await expect(
      client.query('DELETE FROM "Invoice" WHERE "id" = $1', [invoice.id]),
    ).rejects.toMatchObject({ code: FK_VIOLATION });
  });

  it("defaults createdAt and accepts a null groupId", async () => {
    const { s } = await world();
    const invoice = await seed(s.org.id, s.member.id);
    await client.query(
      `INSERT INTO "InvoiceEvent" ("id","invoiceId","type","actorUserId","organizationId")
       VALUES ($1,$2,'INVOICE_DELETED',$3,$4)`,
      [randomUUID(), invoice.id, s.member.id, s.org.id],
    );

    const [event] = await eventsOf(invoice.id);
    expect(event.groupId).toBeNull();
    expect(event.createdAt).toBeInstanceOf(Date);
  });
});

describe("RP0-12 permission change races (AC-13)", () => {
  it("makes a DELETE wait for a revoking change and then answer 403", async () => {
    const { s, cookie } = await world(DELETE_OWN);
    const invoice = await seed(s.org.id, s.member.id);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        'SELECT id FROM "OrganizationMembership" WHERE "userId" = $1 AND "organizationId" = $2 FOR UPDATE',
        [s.member.id, s.org.id],
      );
      await holder.query(
        'UPDATE "OrganizationMembership" SET "deleteOwnInvoices" = false WHERE "userId" = $1 AND "organizationId" = $2',
        [s.member.id, s.org.id],
      );

      const pending = remove(cookie, s, invoice.id).then(
        (response) => response,
      );
      await waitUntilBlocked('%FROM "OrganizationMembership"%FOR SHARE%');
      await holder.query("COMMIT");

      const response = await pending;
      expect(response.status).toBe(403);
      expect((await stored(invoice.id)).deletedAt).toBeNull();
      expect(await eventsOf(invoice.id)).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("makes a revoking change wait for an in-flight DELETE and then apply", async () => {
    const { s, cookie } = await world(DELETE_OWN);
    const adminCookie = await cookieFor(s.admin);
    const invoice = await seed(s.org.id, s.member.id);
    const other = await seed(s.org.id, s.member.id);
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
      expect((await remove(cookie, s, invoice.id)).status).toBe(403);
      expect((await remove(cookie, s, other.id)).status).toBe(403);
      expect((await stored(invoice.id)).deletedAt).toBeNull();
      expect(await eventCount(s.org.id)).toBe(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("makes a group DELETE wait for a revoking group-flag change and then answer 403 (CR-333)", async () => {
    const { s, cookie } = await world(NO_FLAGS);
    await addToGroup(s.group.id, s.member.id, s.org.id, DELETE_OWN);
    const invoice = await seed(s.org.id, s.member.id, s.group.id);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        'SELECT id FROM "GroupMembership" WHERE "userId" = $1 AND "groupId" = $2 FOR UPDATE',
        [s.member.id, s.group.id],
      );
      await holder.query(
        'UPDATE "GroupMembership" SET "deleteOwnInvoices" = false WHERE "userId" = $1 AND "groupId" = $2',
        [s.member.id, s.group.id],
      );

      const pending = remove(cookie, s, invoice.id).then(
        (response) => response,
      );
      await waitUntilBlocked('%FROM "GroupMembership"%FOR SHARE%');
      await holder.query("COMMIT");

      const response = await pending;
      expect(response.status).toBe(403);
      expect((await stored(invoice.id)).deletedAt).toBeNull();
      expect(await eventsOf(invoice.id)).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("makes a DELETE wait for the removal of the organization membership and then answer 404 (CR-333)", async () => {
    const { s, cookie } = await world(DELETE_OWN);
    const invoice = await seed(s.org.id, s.member.id);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        'SELECT id FROM "OrganizationMembership" WHERE "userId" = $1 AND "organizationId" = $2 FOR UPDATE',
        [s.member.id, s.org.id],
      );
      await holder.query(
        'DELETE FROM "GroupMembership" WHERE "userId" = $1 AND "organizationId" = $2',
        [s.member.id, s.org.id],
      );
      await holder.query(
        'DELETE FROM "OrganizationMembership" WHERE "userId" = $1 AND "organizationId" = $2',
        [s.member.id, s.org.id],
      );

      const pending = remove(cookie, s, invoice.id).then(
        (response) => response,
      );
      await waitUntilBlocked('%FROM "OrganizationMembership"%FOR SHARE%');
      await holder.query("COMMIT");

      // The lost snapshot race is retried and re-authorized: no membership.
      const response = await pending;
      expect(response.status).toBe(404);
      expect((await stored(invoice.id)).deletedAt).toBeNull();
      expect(await eventsOf(invoice.id)).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("makes a group DELETE wait for the removal of the group membership and then answer 404 (CR-333)", async () => {
    const { s, cookie } = await world(NO_FLAGS);
    await addToGroup(s.group.id, s.member.id, s.org.id, DELETE_OWN);
    const invoice = await seed(s.org.id, s.member.id, s.group.id);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        'SELECT id FROM "GroupMembership" WHERE "userId" = $1 AND "groupId" = $2 FOR UPDATE',
        [s.member.id, s.group.id],
      );
      await holder.query(
        'DELETE FROM "GroupMembership" WHERE "userId" = $1 AND "groupId" = $2',
        [s.member.id, s.group.id],
      );

      const pending = remove(cookie, s, invoice.id).then(
        (response) => response,
      );
      await waitUntilBlocked('%FROM "GroupMembership"%FOR SHARE%');
      await holder.query("COMMIT");

      // Not in the group any more and without organization flags: invisible.
      const response = await pending;
      expect(response.status).toBe(404);
      expect((await stored(invoice.id)).deletedAt).toBeNull();
      expect(await eventsOf(invoice.id)).toHaveLength(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("serializes a DELETE against a concurrent revocation of deleteOwn", async () => {
    for (let round = 0; round < 6; round += 1) {
      const { s, cookie } = await world(DELETE_OWN);
      const adminCookie = await cookieFor(s.admin);
      const invoice = await seed(s.org.id, s.member.id);

      const [deleted, revoke] = await Promise.all([
        remove(cookie, s, invoice.id).then((response) => response),
        call("put", orgFlagsPath(s, s.member.id), adminCookie, {
          permissions: NO_FLAGS,
        }).then((response) => response),
      ]);

      expect(revoke.status).toBe(200);
      // Deleted under the old permission, or forbidden by the revocation.
      expect([204, 403]).toContain(deleted.status);
      const row = await stored(invoice.id);
      expect(row.deletedAt !== null).toBe(deleted.status === 204);
      expect(await eventsOf(invoice.id)).toHaveLength(
        deleted.status === 204 ? 1 : 0,
      );
      // Whatever happened, the revocation is in force afterwards: a repeated
      // DELETE is re-authorized, even on an already deleted invoice (AC-11).
      const again = await remove(cookie, s, invoice.id);
      expect(again.status).toBe(403);
    }
  });

  it("serializes a DELETE against a concurrent swap of deleteOwn for deleteOthers", async () => {
    for (let round = 0; round < 4; round += 1) {
      const { s, cookie } = await world(DELETE_OWN);
      const adminCookie = await cookieFor(s.admin);
      const own = await seed(s.org.id, s.member.id);

      const [deleted, swap] = await Promise.all([
        remove(cookie, s, own.id).then((response) => response),
        call("put", orgFlagsPath(s, s.member.id), adminCookie, {
          permissions: DELETE_OTHERS,
        }).then((response) => response),
      ]);

      expect(swap.status).toBe(200);
      expect([204, 403]).toContain(deleted.status);
      expect((await stored(own.id)).deletedAt !== null).toBe(
        deleted.status === 204,
      );
      expect(await eventsOf(own.id)).toHaveLength(
        deleted.status === 204 ? 1 : 0,
      );
    }
  });

  it("serializes a group DELETE against the revocation of the group flag", async () => {
    for (let round = 0; round < 4; round += 1) {
      const { s, cookie } = await world(NO_FLAGS);
      await addToGroup(s.group.id, s.member.id, s.org.id, DELETE_OWN);
      const adminCookie = await cookieFor(s.admin);
      const invoice = await seed(s.org.id, s.member.id, s.group.id);

      const [deleted, revoke] = await Promise.all([
        remove(cookie, s, invoice.id).then((response) => response),
        call("put", groupFlagsPath(s, s.member.id), adminCookie, {
          permissions: NO_FLAGS,
        }).then((response) => response),
      ]);

      expect(revoke.status).toBe(200);
      expect([204, 403]).toContain(deleted.status);
      expect((await stored(invoice.id)).deletedAt !== null).toBe(
        deleted.status === 204,
      );
      expect(await eventsOf(invoice.id)).toHaveLength(
        deleted.status === 204 ? 1 : 0,
      );
    }
  });

  it("serializes a DELETE against the removal of the organization membership", async () => {
    for (let round = 0; round < 4; round += 1) {
      const { s, cookie } = await world(DELETE_OWN);
      const adminCookie = await cookieFor(s.admin);
      const invoice = await seed(s.org.id, s.member.id);

      const [deleted, removal] = await Promise.all([
        remove(cookie, s, invoice.id).then((response) => response),
        call(
          "delete",
          `/organizations/${s.org.id}/memberships/${s.member.id}`,
          adminCookie,
        ).then((response) => response),
      ]);

      expect(removal.status).toBe(204);
      expect([204, 404]).toContain(deleted.status);
      expect((await stored(invoice.id)).deletedAt !== null).toBe(
        deleted.status === 204,
      );
      expect(await eventsOf(invoice.id)).toHaveLength(
        deleted.status === 204 ? 1 : 0,
      );
      // The removed member can no longer delete anything.
      expect(
        (await remove(cookie, s, (await seed(s.org.id, s.admin.id)).id)).status,
      ).toBe(404);
    }
  });

  it("serializes a group DELETE against the removal of the group membership", async () => {
    for (let round = 0; round < 4; round += 1) {
      const { s, cookie } = await world(NO_FLAGS);
      await addToGroup(s.group.id, s.member.id, s.org.id, DELETE_OWN);
      const adminCookie = await cookieFor(s.admin);
      const invoice = await seed(s.org.id, s.member.id, s.group.id);

      const [deleted, removal] = await Promise.all([
        remove(cookie, s, invoice.id).then((response) => response),
        call(
          "delete",
          `/organizations/${s.org.id}/groups/${s.group.id}/memberships/${s.member.id}`,
          adminCookie,
        ).then((response) => response),
      ]);

      expect(removal.status).toBe(204);
      // After the removal the group invoice is invisible to the member.
      expect([204, 404]).toContain(deleted.status);
      expect((await stored(invoice.id)).deletedAt !== null).toBe(
        deleted.status === 204,
      );
      expect(await eventsOf(invoice.id)).toHaveLength(
        deleted.status === 204 ? 1 : 0,
      );
    }
  });
});

describe("RP0-12 concurrent DELETEs and rollback (AC-11, AC-13)", () => {
  it.each([2, 6])(
    "leaves one event and one tombstone for %i concurrent DELETEs of the same invoice",
    async (parallel) => {
      for (let round = 0; round < 3; round += 1) {
        const { s, cookie } = await world();
        const invoice = await seed(s.org.id, s.member.id, s.group.id);

        const responses = await Promise.all(
          Array.from({ length: parallel }, () =>
            remove(cookie, s, invoice.id).then((response) => response),
          ),
        );

        // Bounded retries may exhaust under contention: the documented 503.
        for (const response of responses) {
          expect([204, 503]).toContain(response.status);
          if (response.status === 503) {
            expect(response.body.error.code).toBe("RETRYABLE_CONFLICT");
            expect(response.headers["retry-after"]).toBeDefined();
          }
        }
        expect(
          responses.filter((response) => response.status === 204).length,
        ).toBeGreaterThanOrEqual(1);
        const row = await stored(invoice.id);
        expect(row.deletedAt).not.toBeNull();
        expect(row.deletedByUserId).toBe(s.member.id);
        expect(await eventsOf(invoice.id)).toHaveLength(1);
        // A repeat after the race is still a 204 without a second event.
        expect((await remove(cookie, s, invoice.id)).status).toBe(204);
        expect(await eventsOf(invoice.id)).toHaveLength(1);
      }
    },
  );

  it("leaves no tombstone when the event insert fails, and succeeds once it works", async () => {
    const { s, cookie } = await world();
    const invoice = await seed(s.org.id, s.member.id);
    const suffix = randomUUID().replaceAll("-", "");
    const fn = `fail_invoice_event_${suffix}`;
    const trigger = `fail_invoice_event_trg_${suffix}`;
    // Scoped to this organization so concurrent suites are unaffected.
    await client.query(`
      CREATE FUNCTION "${fn}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."organizationId" = '${s.org.id}' THEN
          RAISE EXCEPTION 'forced InvoiceEvent failure';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql`);
    await client.query(
      `CREATE TRIGGER "${trigger}" BEFORE INSERT ON "InvoiceEvent"
       FOR EACH ROW EXECUTE FUNCTION "${fn}"()`,
    );
    try {
      const failed = await remove(cookie, s, invoice.id);

      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(failed.body)).not.toContain("forced");
      const row = await stored(invoice.id);
      expect(row.deletedAt).toBeNull();
      expect(row.deletedByUserId).toBeNull();
      expect(await eventsOf(invoice.id)).toHaveLength(0);
    } finally {
      await client.query(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "InvoiceEvent"`,
      );
      await client.query(`DROP FUNCTION IF EXISTS "${fn}"()`);
    }

    expect((await remove(cookie, s, invoice.id)).status).toBe(204);
    expect(await eventsOf(invoice.id)).toHaveLength(1);
  });
});
