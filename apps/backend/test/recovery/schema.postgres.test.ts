import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "../../src/database.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

const url = recoveryTestDatabaseUrl();

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

async function createGroup(organizationId: string) {
  const id = randomUUID();
  await client.query(
    'INSERT INTO "Group" ("id","organizationId","name") VALUES ($1,$2,$3)',
    [id, organizationId, `group-${id}`],
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
    `INSERT INTO "Invoice" ("id","businessId","organizationId","groupId","scopeKey","supplierName","amountPesos","currency","issuedOn","dueOn","businessStatus","createdByUserId","deletedAt","deletedByUserId")
     VALUES ($1,$2,$3,$4,$4,$5,$6,'CLP',$7,$8,'PENDING',$9,$10,$11)`,
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

  it("keeps only identity columns on Group and on GroupMembership besides the four member flags", async () => {
    const group = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='Group' ORDER BY column_name`,
    );
    expect(group.rows.map((row) => row.column_name)).toEqual([
      "description",
      "id",
      "name",
      "organizationId",
    ]);
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='GroupMembership' ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "createInvoices",
      "deleteOthersInvoices",
      "deleteOwnInvoices",
      "groupId",
      "id",
      "organizationId",
      "readInvoices",
      "userId",
    ]);
  });

  it("stores independent flags per member of one group, defaulting to false", async () => {
    const org = await createOrganization("org-members");
    const group = await createGroup(org);
    const memberA = await createUser("member-a");
    const memberB = await createUser("member-b");
    for (const member of [memberA, memberB]) {
      await client.query(
        'INSERT INTO "OrganizationMembership" ("id","userId","organizationId","role") VALUES ($1,$2,$3,\'USER\')',
        [randomUUID(), member, org],
      );
    }
    await client.query(
      'INSERT INTO "GroupMembership" ("id","groupId","userId","organizationId","readInvoices","deleteOthersInvoices") VALUES ($1,$2,$3,$4,true,true)',
      [randomUUID(), group, memberA, org],
    );
    await client.query(
      'INSERT INTO "GroupMembership" ("id","groupId","userId","organizationId") VALUES ($1,$2,$3,$4)',
      [randomUUID(), group, memberB, org],
    );
    const result = await client.query(
      `SELECT "userId","readInvoices","createInvoices","deleteOwnInvoices","deleteOthersInvoices"
       FROM "GroupMembership" WHERE "groupId" = $1`,
      [group],
    );
    const byUser = Object.fromEntries(
      result.rows.map((row) => [row.userId, row]),
    );
    expect(byUser[memberA]).toMatchObject({
      readInvoices: true,
      createInvoices: false,
      deleteOwnInvoices: false,
      deleteOthersInvoices: true,
    });
    expect(byUser[memberB]).toMatchObject({
      readInvoices: false,
      createInvoices: false,
      deleteOwnInvoices: false,
      deleteOthersInvoices: false,
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
        `INSERT INTO "InvoiceIdempotencyRecord" ("id","userId","organizationId","groupId","scopeKey","operation","key","fingerprint","fingerprintVersion","invoiceId","responseSnapshot")
         VALUES ($1,$2,$3,$4,$4,$5,$6,'fp',1,$7,'{"ok":true}'::jsonb)`,
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
        `INSERT INTO "InvoiceIdempotencyRecord" ("id","userId","organizationId","groupId","scopeKey","operation","key","fingerprint","fingerprintVersion","invoiceId","responseSnapshot")
         VALUES ($1,$2,$3,$4,$4,'op','k','fp',1,$5,'{}'::jsonb)`,
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
        `INSERT INTO "InvoiceIdempotencyRecord" ("id","userId","organizationId","groupId","scopeKey","operation","key","fingerprint","fingerprintVersion","invoiceId","responseSnapshot")
         VALUES ($1,$2,$3,$4,$4,'op',$5,'fp',1,$6,'{}'::jsonb)`,
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

// RP0-22: membership-level permissions and optional group scope.
const PERMISSION_COLUMNS = [
  "readInvoices",
  "createInvoices",
  "deleteOwnInvoices",
  "deleteOthersInvoices",
];

async function columnInfo(table: string, column: string) {
  const result = await client.query(
    `SELECT is_nullable, data_type, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column],
  );
  return result.rows[0] as
    | { is_nullable: string; data_type: string; column_default: string | null }
    | undefined;
}

async function insertScopedInvoice(
  scopedOrganizationId: string,
  scopedGroupId: string | null,
  createdByUserId: string,
  overrides: { businessId?: string; scopeKey?: string } = {},
) {
  const id = randomUUID();
  const businessId = overrides.businessId ?? `FAC-${randomUUID()}`;
  const scopeKey = overrides.scopeKey ?? scopedGroupId ?? "organization";
  await client.query(
    `INSERT INTO "Invoice" ("id","businessId","organizationId","groupId","scopeKey","supplierName","amountPesos","currency","issuedOn","dueOn","businessStatus","createdByUserId")
     VALUES ($1,$2,$3,$4,$5,'Proveedor local',12500,'CLP','2026-10-25','2026-11-25','PENDING',$6)`,
    [
      id,
      businessId,
      scopedOrganizationId,
      scopedGroupId,
      scopeKey,
      createdByUserId,
    ],
  );
  return { id, businessId, scopeKey };
}

async function insertScopedRecord(input: {
  userId: string;
  organizationId: string;
  groupId: string | null;
  scopeKey?: string;
  operation?: string;
  key: string;
  invoiceId: string;
}) {
  await client.query(
    `INSERT INTO "InvoiceIdempotencyRecord" ("id","userId","organizationId","groupId","scopeKey","operation","key","fingerprint","fingerprintVersion","invoiceId","responseSnapshot")
     VALUES ($1,$2,$3,$4,$5,$6,$7,'fp',1,$8,'{"ok":true}'::jsonb)`,
    [
      randomUUID(),
      input.userId,
      input.organizationId,
      input.groupId,
      input.scopeKey ?? input.groupId ?? "organization",
      input.operation ?? "POST:/api/v1/invoices",
      input.key,
      input.invoiceId,
    ],
  );
}

async function uniqueIndexColumns(table: string) {
  const result = await client.query(
    `SELECT i.indexrelid::regclass::text AS name,
            array_agg(a.attname::text ORDER BY k.ord) AS columns
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE c.relname = $1 AND i.indisunique
      GROUP BY i.indexrelid`,
    [table],
  );
  return result.rows.map((row) => row.columns as string[]);
}

describe("RP0-22 schema: membership permissions", () => {
  it("removes the four flags from Group", async () => {
    for (const column of PERMISSION_COLUMNS) {
      expect(await columnInfo("Group", column)).toBeUndefined();
    }
  });

  it.each(["OrganizationMembership", "GroupMembership"])(
    "stores four NOT NULL boolean flags defaulting to false on %s",
    async (table) => {
      for (const column of PERMISSION_COLUMNS) {
        const info = await columnInfo(table, column);
        expect(info, `${table}.${column} must exist`).toBeDefined();
        expect(info).toMatchObject({
          is_nullable: "NO",
          data_type: "boolean",
          column_default: "false",
        });
      }
    },
  );
});

describe("B3b-FIX schema: audit payload and admin lookup index", () => {
  it("stores nullable flag columns and a NOT NULL actorIsTarget on the audit table", async () => {
    for (const column of PERMISSION_COLUMNS) {
      expect(
        await columnInfo("PlatformAdministrativeAuditEvent", column),
      ).toMatchObject({ is_nullable: "YES", data_type: "boolean" });
    }
    expect(
      await columnInfo("PlatformAdministrativeAuditEvent", "actorIsTarget"),
    ).toMatchObject({
      is_nullable: "NO",
      data_type: "boolean",
      column_default: "false",
    });
  });

  it("indexes OrganizationMembership by (organizationId, role) for the last-admin count", async () => {
    const result = await client.query(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'OrganizationMembership'
         AND indexname = 'OrganizationMembership_organizationId_role_idx'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.indexdef).toContain('("organizationId", role)');
  });

  it("accepts the new audit event types", async () => {
    const result = await client.query(
      `SELECT unnest(enum_range(NULL::"PlatformAdministrativeAuditEventType"))::text AS value`,
    );
    const values = result.rows.map((row) => row.value);
    expect(values).toEqual(
      expect.arrayContaining([
        "MEMBERSHIP_PERMISSIONS_CHANGED",
        "GROUP_MEMBERSHIP_CREATED",
        "GROUP_MEMBERSHIP_REMOVED",
      ]),
    );
  });
});

describe("RP0-22 schema: optional group scope on Invoice", () => {
  it("makes groupId nullable and adds a NOT NULL text scopeKey", async () => {
    expect(await columnInfo("Invoice", "groupId")).toMatchObject({
      is_nullable: "YES",
    });
    expect(await columnInfo("Invoice", "scopeKey")).toMatchObject({
      is_nullable: "NO",
      data_type: "text",
    });
  });

  it("allows an organization-scope invoice with NULL groupId", async () => {
    const org = await createOrganization("org-scope");
    const row = await insertScopedInvoice(org, null, userId);
    const stored = await client.query(
      'SELECT "groupId","scopeKey" FROM "Invoice" WHERE id = $1',
      [row.id],
    );
    expect(stored.rows[0]).toEqual({ groupId: null, scopeKey: "organization" });
  });

  it("stores the group id as scopeKey for a group invoice", async () => {
    const row = await insertScopedInvoice(organizationId, groupId, userId);
    const stored = await client.query(
      'SELECT "scopeKey" FROM "Invoice" WHERE id = $1',
      [row.id],
    );
    expect(stored.rows[0].scopeKey).toBe(groupId);
  });

  it("rejects a scopeKey that differs from COALESCE(groupId, 'organization')", async () => {
    await expectCode(
      insertScopedInvoice(organizationId, groupId, userId, {
        scopeKey: "organization",
      }),
      CHECK_VIOLATION,
    );
    await expectCode(
      insertScopedInvoice(organizationId, null, userId, {
        scopeKey: groupId,
      }),
      CHECK_VIOLATION,
    );
  });

  it("still rejects a group from another organization (composite FK)", async () => {
    await expectCode(
      insertScopedInvoice(otherOrganizationId, groupId, userId),
      FK_VIOLATION,
    );
  });

  it("keeps businessId unique across organization scope and group scope", async () => {
    const org = await createOrganization("org-unique");
    const group = await createGroup(org);
    const businessId = `ACROSS-${randomUUID()}`;
    await insertScopedInvoice(org, null, userId, { businessId });
    await expectCode(
      insertScopedInvoice(org, group, userId, { businessId }),
      UNIQUE_VIOLATION,
    );
    await expectCode(
      insertScopedInvoice(org, null, userId, { businessId }),
      UNIQUE_VIOLATION,
    );
    const other = `ACROSS-${randomUUID()}`;
    await insertScopedInvoice(org, group, userId, { businessId: other });
    await expectCode(
      insertScopedInvoice(org, null, userId, { businessId: other }),
      UNIQUE_VIOLATION,
    );
  });

  it("has a unique constraint on (id, organizationId, scopeKey)", async () => {
    const indexes = await uniqueIndexColumns("Invoice");
    expect(indexes).toContainEqual(["id", "organizationId", "scopeKey"]);
  });
});

describe("RP0-22 schema: idempotency records with optional group scope", () => {
  it("makes groupId nullable and adds a NOT NULL scopeKey", async () => {
    expect(
      await columnInfo("InvoiceIdempotencyRecord", "groupId"),
    ).toMatchObject({ is_nullable: "YES" });
    expect(
      await columnInfo("InvoiceIdempotencyRecord", "scopeKey"),
    ).toMatchObject({ is_nullable: "NO", data_type: "text" });
  });

  it("conflicts for two NULL-group records with the same user, organization, operation and key", async () => {
    const org = await createOrganization("org-idem-null");
    const invoice = await insertScopedInvoice(org, null, userId);
    const key = `key-${randomUUID()}`;
    const record = {
      userId,
      organizationId: org,
      groupId: null,
      key,
      invoiceId: invoice.id,
    };
    await insertScopedRecord(record);
    await expectCode(insertScopedRecord(record), UNIQUE_VIOLATION);
    await insertScopedRecord({ ...record, operation: "OTHER" });
  });

  it("does not conflict between organization scope and a group scope with the same key", async () => {
    const org = await createOrganization("org-idem-mixed");
    const group = await createGroup(org);
    const orgInvoice = await insertScopedInvoice(org, null, userId);
    const groupInvoice = await insertScopedInvoice(org, group, userId);
    const key = `key-${randomUUID()}`;
    await insertScopedRecord({
      userId,
      organizationId: org,
      groupId: null,
      key,
      invoiceId: orgInvoice.id,
    });
    await insertScopedRecord({
      userId,
      organizationId: org,
      groupId: group,
      key,
      invoiceId: groupInvoice.id,
    });
  });

  it("has a unique constraint on (userId, organizationId, scopeKey, operation, key)", async () => {
    const indexes = await uniqueIndexColumns("InvoiceIdempotencyRecord");
    expect(indexes).toContainEqual([
      "userId",
      "organizationId",
      "scopeKey",
      "operation",
      "key",
    ]);
  });

  it("rejects a scopeKey that differs from COALESCE(groupId, 'organization')", async () => {
    const org = await createOrganization("org-idem-check");
    const invoice = await insertScopedInvoice(org, null, userId);
    await expectCode(
      insertScopedRecord({
        userId,
        organizationId: org,
        groupId: null,
        scopeKey: "something-else",
        key: `key-${randomUUID()}`,
        invoiceId: invoice.id,
      }),
      CHECK_VIOLATION,
    );
  });

  it("rejects a record whose scope differs from the scope of its invoice", async () => {
    const org = await createOrganization("org-idem-fk");
    const group = await createGroup(org);
    const groupInvoice = await insertScopedInvoice(org, group, userId);
    const orgInvoice = await insertScopedInvoice(org, null, userId);
    await expectCode(
      insertScopedRecord({
        userId,
        organizationId: org,
        groupId: null,
        key: `key-${randomUUID()}`,
        invoiceId: groupInvoice.id,
      }),
      FK_VIOLATION,
    );
    await expectCode(
      insertScopedRecord({
        userId,
        organizationId: org,
        groupId: group,
        key: `key-${randomUUID()}`,
        invoiceId: orgInvoice.id,
      }),
      FK_VIOLATION,
    );
  });

  it("rejects a dangling invoiceId with NULL groupId", async () => {
    await expectCode(
      insertScopedRecord({
        userId,
        organizationId,
        groupId: null,
        key: `key-${randomUUID()}`,
        invoiceId: randomUUID(),
      }),
      FK_VIOLATION,
    );
  });
});

describe("RP0-22 schema: ApiToken optional group scope", () => {
  const insertToken = (
    tokenOrganizationId: string,
    tokenGroupId: string | null,
  ) =>
    client.query(
      `INSERT INTO "ApiToken" ("id","userId","name","organizationId","groupId","tokenHash","scopes","createdAt","expiresAt")
       VALUES ($1,$2,'cli',$3,$4,$5,ARRAY['invoices:read']::"ApiTokenScope"[],'2026-10-25T00:00:00Z','2026-11-01T00:00:00Z')`,
      [
        randomUUID(),
        userId,
        tokenOrganizationId,
        tokenGroupId,
        `h-${randomUUID()}`,
      ],
    );

  it("makes groupId nullable and accepts an organization-scope token", async () => {
    expect(await columnInfo("ApiToken", "groupId")).toMatchObject({
      is_nullable: "YES",
    });
    await insertToken(organizationId, null);
  });

  it("still rejects a group from another organization (composite FK)", async () => {
    await expectCode(insertToken(otherOrganizationId, groupId), FK_VIOLATION);
  });
});
