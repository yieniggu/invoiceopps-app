import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database.js";

const url = process.env.RECOVERY_TEST_DATABASE_URL;
if (!url) {
  throw new Error("RECOVERY_TEST_DATABASE_URL must be configured");
}
if (new URL(url).pathname !== "/invoiceops_recovery_test") {
  throw new Error(
    "RECOVERY_TEST_DATABASE_URL must target invoiceops_recovery_test",
  );
}

const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

async function createUser(label: string) {
  const id = randomUUID();
  await client.query(
    'INSERT INTO "User" ("id","name","rut") VALUES ($1,$2,$3)',
    [id, label, `rut-${id}`],
  );
  return id;
}

async function createOrganization(label: string) {
  const id = randomUUID();
  await client.query(
    'INSERT INTO "Organization" ("id","name","slug","updatedAt") VALUES ($1,$2,$3,CURRENT_TIMESTAMP)',
    [id, label, `${label}-${id}`],
  );
  return id;
}

async function createGroup(
  organizationId: string,
  flags: Partial<Record<string, boolean>> = {},
) {
  const id = randomUUID();
  const columns = ['"id"', '"organizationId"', '"name"'];
  const values: unknown[] = [id, organizationId, `group-${id}`];
  for (const [flag, value] of Object.entries(flags)) {
    columns.push(`"${flag}"`);
    values.push(value);
  }
  await client.query(
    `INSERT INTO "Group" (${columns.join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")})`,
    values,
  );
  return id;
}

type InvoiceOverrides = Partial<{
  id: string;
  businessId: string;
  supplierName: string;
  amountPesos: number;
  issuedOn: string;
  dueOn: string;
  deletedAt: string | null;
  deletedByUserId: string | null;
  createdByUserId: string;
}>;

async function insertInvoice(
  organizationId: string,
  groupId: string,
  createdByUserId: string,
  overrides: InvoiceOverrides = {},
) {
  const row = {
    id: randomUUID(),
    businessId: `FAC-${randomUUID()}`,
    supplierName: "Proveedor local",
    amountPesos: 12500,
    issuedOn: "2026-10-25",
    dueOn: "2026-11-25",
    deletedAt: null,
    deletedByUserId: null,
    createdByUserId,
    ...overrides,
  };
  await client.query(
    `INSERT INTO "Invoice" ("id","businessId","organizationId","groupId","supplierName","amountPesos","currency","issuedOn","dueOn","businessStatus","createdByUserId","deletedAt","deletedByUserId")
     VALUES ($1,$2,$3,$4,$5,$6,'CLP',$7,$8,'PENDING',$9,$10,$11)`,
    [
      row.id,
      row.businessId,
      organizationId,
      groupId,
      row.supplierName,
      row.amountPesos,
      row.issuedOn,
      row.dueOn,
      row.createdByUserId,
      row.deletedAt,
      row.deletedByUserId,
    ],
  );
  return row;
}

let organizationId: string;
let otherOrganizationId: string;
let groupId: string;
let userId: string;

beforeAll(async () => {
  await client.connect();
  organizationId = await createOrganization("org-a");
  otherOrganizationId = await createOrganization("org-b");
  groupId = await createGroup(organizationId);
  userId = await createUser("creator");
});

afterAll(async () => {
  await client.end();
  await database.prisma.$disconnect();
});

describe("consolidated schema on real PostgreSQL", () => {
  it("applies the baseline migration first and completely", async () => {
    const result = await client.query(
      'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name',
    );
    expect(result.rows[0].migration_name).toBe(
      "20261026000000_initial_recovery_p0",
    );
    for (const row of result.rows) {
      expect(row.finished_at).not.toBeNull();
      expect(row.rolled_back_at).toBeNull();
    }
  });

  it("has role USER and not STUDENT", async () => {
    const result = await client.query(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'OrganizationRole' ORDER BY e.enumsortorder`,
    );
    expect(result.rows.map((row) => row.enumlabel)).toEqual(["ADMIN", "USER"]);
  });

  it("drops legacy tables", async () => {
    const result = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [
        [
          "ResourceReference",
          "DecisionEvent",
          "EvidenceRecord",
          "EvidenceBatch",
          "AuthorizedUserOrganization",
        ],
      ],
    );
    expect(result.rows).toEqual([]);
  });

  it("stores the four group flags defaulting to false and no member permission columns", async () => {
    const group = await client.query(
      'SELECT "readInvoices","createInvoices","deleteOwnInvoices","deleteOthersInvoices" FROM "Group" WHERE id = $1',
      [groupId],
    );
    expect(group.rows[0]).toEqual({
      readInvoices: false,
      createInvoices: false,
      deleteOwnInvoices: false,
      deleteOthersInvoices: false,
    });
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='GroupMembership' ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "groupId",
      "id",
      "organizationId",
      "userId",
    ]);
  });

  it("members of one group share its configuration and another group keeps its own", async () => {
    const org = await createOrganization("org-shared");
    const shared = await createGroup(org, {
      readInvoices: true,
      createInvoices: true,
    });
    const other = await createGroup(org, { deleteOthersInvoices: true });
    const memberA = await createUser("member-a");
    const memberB = await createUser("member-b");
    for (const member of [memberA, memberB]) {
      await client.query(
        'INSERT INTO "OrganizationMembership" ("id","userId","organizationId","role") VALUES ($1,$2,$3,\'USER\')',
        [randomUUID(), member, org],
      );
      await client.query(
        'INSERT INTO "GroupMembership" ("id","groupId","userId","organizationId") VALUES ($1,$2,$3,$4)',
        [randomUUID(), shared, member, org],
      );
    }
    const result = await client.query(
      `SELECT gm."userId", g."readInvoices", g."createInvoices", g."deleteOwnInvoices", g."deleteOthersInvoices"
       FROM "GroupMembership" gm JOIN "Group" g ON g.id = gm."groupId" WHERE gm."groupId" = $1 ORDER BY gm."userId"`,
      [shared],
    );
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row).toMatchObject({
        readInvoices: true,
        createInvoices: true,
        deleteOwnInvoices: false,
        deleteOthersInvoices: false,
      });
    }
    const otherFlags = await client.query(
      'SELECT "readInvoices","deleteOthersInvoices" FROM "Group" WHERE id = $1',
      [other],
    );
    expect(otherFlags.rows[0]).toEqual({
      readInvoices: false,
      deleteOthersInvoices: true,
    });
  });

  it("rejects a group that belongs to another organization (composite FK)", async () => {
    await expectCode(
      insertInvoice(otherOrganizationId, groupId, userId),
      FK_VIOLATION,
    );
  });

  it("requires an existing creator", async () => {
    await expectCode(
      insertInvoice(organizationId, groupId, randomUUID()),
      FK_VIOLATION,
    );
  });

  it("keeps businessId unique per organization, even after soft delete", async () => {
    const businessId = `UNIQ-${randomUUID()}`;
    const first = await insertInvoice(organizationId, groupId, userId, {
      businessId,
    });
    await expectCode(
      insertInvoice(organizationId, groupId, userId, { businessId }),
      UNIQUE_VIOLATION,
    );
    await client.query(
      'UPDATE "Invoice" SET "deletedAt" = now(), "deletedByUserId" = $2 WHERE id = $1',
      [first.id, userId],
    );
    await expectCode(
      insertInvoice(organizationId, groupId, userId, { businessId }),
      UNIQUE_VIOLATION,
    );
    const otherGroup = await createGroup(otherOrganizationId);
    await insertInvoice(otherOrganizationId, otherGroup, userId, {
      businessId,
    });
  });

  it("enforces amountPesos range and round-trips 12500 exactly", async () => {
    for (const amountPesos of [0, -1]) {
      await expectCode(
        insertInvoice(organizationId, groupId, userId, { amountPesos }),
        CHECK_VIOLATION,
      );
    }
    await expect(
      insertInvoice(organizationId, groupId, userId, {
        amountPesos: 2147483648,
      }),
    ).rejects.toThrow();
    await insertInvoice(organizationId, groupId, userId, { amountPesos: 1 });
    await insertInvoice(organizationId, groupId, userId, {
      amountPesos: 2147483647,
    });
    const row = await insertInvoice(organizationId, groupId, userId, {
      amountPesos: 12500,
    });
    const stored = await client.query(
      'SELECT "amountPesos" FROM "Invoice" WHERE id = $1',
      [row.id],
    );
    expect(stored.rows[0].amountPesos).toBe(12500);
  });

  it("stores civil dates without timezone shift and rejects dueOn before issuedOn", async () => {
    const row = await insertInvoice(organizationId, groupId, userId, {
      issuedOn: "2026-10-25",
      dueOn: "2026-10-25",
    });
    const stored = await client.query(
      `SELECT to_char("issuedOn",'YYYY-MM-DD') AS issued, to_char("dueOn",'YYYY-MM-DD') AS due FROM "Invoice" WHERE id = $1`,
      [row.id],
    );
    expect(stored.rows[0]).toEqual({ issued: "2026-10-25", due: "2026-10-25" });
    await expectCode(
      insertInvoice(organizationId, groupId, userId, {
        issuedOn: "2026-10-25",
        dueOn: "2026-10-24",
      }),
      CHECK_VIOLATION,
    );
    const viaPrisma = await database.prisma.invoice.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(viaPrisma.issuedOn.toISOString().slice(0, 10)).toBe("2026-10-25");
    expect(viaPrisma.amountPesos).toBe(12500);
  });

  it("rejects blank or oversized business identifiers and supplier names", async () => {
    await expectCode(
      insertInvoice(organizationId, groupId, userId, { businessId: "   " }),
      CHECK_VIOLATION,
    );
    await expectCode(
      insertInvoice(organizationId, groupId, userId, {
        businessId: "x".repeat(81),
      }),
      "22001",
    );
    await expectCode(
      insertInvoice(organizationId, groupId, userId, { supplierName: "  " }),
      CHECK_VIOLATION,
    );
  });

  it("rejects untrimmed business identifiers and supplier names", async () => {
    for (const overrides of [
      { businessId: " FAC-1" },
      { businessId: "FAC-1 " },
      { supplierName: " Proveedor" },
      { supplierName: "Proveedor " },
      { businessId: "\tFAC-1" },
      { businessId: "FAC-1\t" },
      { businessId: "FAC-1\n" },
      { businessId: "\nFAC-1" },
      { supplierName: "\tProveedor" },
      { supplierName: "Proveedor\n" },
      { supplierName: "Proveedor\r\n" },
      { supplierName: "\t\n" },
      // Form feed and vertical tab (\x0b) are trimmed by the CHECK too.
      { businessId: "\fFAC-1" },
      { businessId: "FAC-1\f" },
      { businessId: "\x0bFAC-1" },
      { businessId: "FAC-1\x0b" },
      { businessId: "\f\x0b" },
      { supplierName: "\fProveedor" },
      { supplierName: "Proveedor\f" },
      { supplierName: "\x0bProveedor" },
      { supplierName: "Proveedor\x0b" },
      { supplierName: "\f\x0b" },
    ]) {
      await expectCode(
        insertInvoice(organizationId, groupId, userId, overrides),
        CHECK_VIOLATION,
      );
    }
  });

  it("accepts single-character values and inner whitespace", async () => {
    await insertInvoice(organizationId, groupId, userId, {
      businessId: "A",
      supplierName: "B",
    });
    await insertInvoice(organizationId, groupId, userId, {
      businessId: "FAC 2\t3",
      supplierName: "Proveedor\nSpA",
    });
    await insertInvoice(organizationId, groupId, userId, {
      businessId: "FAC\f4\x0b5",
      supplierName: "Proveedor\fSpA\x0bLtda",
    });
  });

  it("pairs deletedAt with deletedByUserId", async () => {
    await expectCode(
      insertInvoice(organizationId, groupId, userId, {
        deletedAt: "2026-10-25T10:00:00Z",
        deletedByUserId: null,
      }),
      CHECK_VIOLATION,
    );
    await expectCode(
      insertInvoice(organizationId, groupId, userId, {
        deletedAt: null,
        deletedByUserId: userId,
      }),
      CHECK_VIOLATION,
    );
    await insertInvoice(organizationId, groupId, userId, {
      deletedAt: "2026-10-25T10:00:00Z",
      deletedByUserId: userId,
    });
  });

  it("scopes idempotency records uniquely", async () => {
    const invoice = await insertInvoice(organizationId, groupId, userId);
    const insert = (key: string, operation = "POST:/api/v1/invoices") =>
      client.query(
        `INSERT INTO "InvoiceIdempotencyRecord" ("id","userId","organizationId","groupId","operation","key","fingerprint","fingerprintVersion","invoiceId","responseSnapshot")
         VALUES ($1,$2,$3,$4,$5,$6,'fp',1,$7,'{"ok":true}'::jsonb)`,
        [
          randomUUID(),
          userId,
          organizationId,
          groupId,
          operation,
          key,
          invoice.id,
        ],
      );
    const key = `key-${randomUUID()}`;
    await insert(key);
    await expectCode(insert(key), UNIQUE_VIOLATION);
    await insert(key, "OTHER");
    await expectCode(
      client.query(
        `INSERT INTO "InvoiceIdempotencyRecord" ("id","userId","organizationId","groupId","operation","key","fingerprint","fingerprintVersion","invoiceId","responseSnapshot")
         VALUES ($1,$2,$3,$4,'op','k','fp',1,$5,'{}'::jsonb)`,
        [randomUUID(), userId, otherOrganizationId, groupId, invoice.id],
      ),
      FK_VIOLATION,
    );
  });

  it("binds an idempotency record to the organization and group of its invoice", async () => {
    const otherGroup = await createGroup(organizationId);
    const invoice = await insertInvoice(organizationId, groupId, userId);
    await expectCode(
      client.query(
        `INSERT INTO "InvoiceIdempotencyRecord" ("id","userId","organizationId","groupId","operation","key","fingerprint","fingerprintVersion","invoiceId","responseSnapshot")
         VALUES ($1,$2,$3,$4,'op',$5,'fp',1,$6,'{}'::jsonb)`,
        [
          randomUUID(),
          userId,
          organizationId,
          otherGroup,
          randomUUID(),
          invoice.id,
        ],
      ),
      FK_VIOLATION,
    );
  });

  it("constrains ApiToken scopes and lifetime", async () => {
    const insert = (scopes: string, expiresAt = "2026-11-01T00:00:00Z") =>
      client.query(
        `INSERT INTO "ApiToken" ("id","userId","name","organizationId","groupId","tokenHash","scopes","createdAt","expiresAt")
         VALUES ($1,$2,'cli',$3,$4,$5,${scopes},'2026-10-25T00:00:00Z',$6)`,
        [
          randomUUID(),
          userId,
          organizationId,
          groupId,
          `h-${randomUUID()}`,
          expiresAt,
        ],
      );
    await expectCode(insert(`'{}'::"ApiTokenScope"[]`), CHECK_VIOLATION);
    await expectCode(
      insert(`ARRAY['invoices:read','invoices:read']::"ApiTokenScope"[]`),
      CHECK_VIOLATION,
    );
    await expectCode(
      insert(
        `ARRAY['invoices:read']::"ApiTokenScope"[]`,
        "2026-11-25T00:00:01Z",
      ),
      CHECK_VIOLATION,
    );
    await insert(
      `ARRAY['invoices:read','invoices:create']::"ApiTokenScope"[]`,
      "2026-11-24T00:00:00Z",
    );
  });

  it("keeps ApiToken hashes unique and requires expiresAt after createdAt", async () => {
    const insert = (hash: string, createdAt: string, expiresAt: string) =>
      client.query(
        `INSERT INTO "ApiToken" ("id","userId","name","organizationId","groupId","tokenHash","scopes","createdAt","expiresAt")
         VALUES ($1,$2,'cli',$3,$4,$5,ARRAY['invoices:read']::"ApiTokenScope"[],$6,$7)`,
        [
          randomUUID(),
          userId,
          organizationId,
          groupId,
          hash,
          createdAt,
          expiresAt,
        ],
      );
    const hash = `hash-${randomUUID()}`;
    await insert(hash, "2026-10-25T00:00:00Z", "2026-11-01T00:00:00Z");
    await expectCode(
      insert(hash, "2026-10-25T00:00:00Z", "2026-11-01T00:00:00Z"),
      UNIQUE_VIOLATION,
    );
    await expectCode(
      insert(
        `h-${randomUUID()}`,
        "2026-10-25T00:00:00Z",
        "2026-10-25T00:00:00Z",
      ),
      CHECK_VIOLATION,
    );
    const labels = await client.query(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ApiTokenScope' ORDER BY e.enumsortorder`,
    );
    expect(labels.rows.map((row) => row.enumlabel)).toEqual([
      "invoices:read",
      "invoices:create",
      "invoices:delete-own",
      "invoices:delete-others",
    ]);
  });
});
