import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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

describe("B3c S1 schema: user deactivation", () => {
  it("adds a nullable timestamp User.disabledAt", async () => {
    expect(await columnInfo("User", "disabledAt")).toMatchObject({
      is_nullable: "YES",
      data_type: "timestamp without time zone",
    });
  });

  it("adds a nullable timestamp User.lastActiveAt", async () => {
    expect(await columnInfo("User", "lastActiveAt")).toMatchObject({
      is_nullable: "YES",
      data_type: "timestamp without time zone",
    });
  });

  it("accepts the USER_DEACTIVATED, USER_REACTIVATED, USER_UPDATED and PASSWORD_RESET audit event types", async () => {
    const result = await client.query(
      `SELECT unnest(enum_range(NULL::"PlatformAdministrativeAuditEventType"))::text AS value`,
    );
    expect(result.rows.map((row) => row.value)).toEqual(
      expect.arrayContaining([
        "USER_DEACTIVATED",
        "USER_REACTIVATED",
        "USER_UPDATED",
        "PASSWORD_RESET",
      ]),
    );
  });
});

describe("B3c follow-up migration", () => {
  it("is applied after the baseline", async () => {
    const result = await client.query(
      'SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name',
    );
    expect(result.rows.map((row) => row.migration_name)).toEqual([
      "20261026000000_initial_recovery_p0",
      "20261028000000_user_status_activity",
      "20261029000000_invoice_events",
    ]);
  });

  it("creates the trigram indexes for the directory and organization searches", async () => {
    const result = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname LIKE '%_trgm_idx'
       ORDER BY indexname`,
    );
    expect(result.rows.map((row) => row.indexname)).toEqual([
      "Invoice_businessId_trgm_idx",
      "Invoice_supplierName_trgm_idx",
      "Organization_name_trgm_idx",
      "User_name_trgm_idx",
      "User_rut_trgm_idx",
    ]);
    for (const row of result.rows) {
      expect(row.indexdef).toMatch(/USING gin .*gin_trgm_ops/);
    }
  });

  it("can be applied again without error (idempotent)", async () => {
    const sql = await readFile(
      new URL(
        "../../prisma/migrations/20261028000000_user_status_activity/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await client.query(sql);
  });

  describe("contact data normalization before the unique indexes (CR-315)", () => {
    const migrationSql = readFile(
      new URL(
        "../../prisma/migrations/20261028000000_user_status_activity/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );

    // Runs the whole migration file inside a transaction that is always rolled
    // back, with the unique indexes dropped so that dirty legacy rows can be
    // seeded the way a database from before the indexes would hold them.
    async function applyOnDirtyRows(
      rows: Array<{ email: string | null; username: string | null }>,
    ) {
      const ids: string[] = [];
      await client.query("BEGIN");
      try {
        await client.query('DROP INDEX "User_email_key"');
        await client.query('DROP INDEX "User_username_key"');
        for (const row of rows) {
          const id = randomUUID();
          ids.push(id);
          await client.query(
            'INSERT INTO "User" ("id","name","rut","email","username") VALUES ($1,$2,$3,$4,$5)',
            [id, "legacy", `rut-${id}`, row.email, row.username],
          );
        }
        await client.query(await migrationSql);
        const stored = await client.query(
          'SELECT "email","username" FROM "User" WHERE "id" = ANY($1) ORDER BY "rut"',
          [ids],
        );
        return stored.rows;
      } finally {
        await client.query("ROLLBACK");
      }
    }

    it("trims and lower-cases emails and turns blank values into NULL", async () => {
      const id = randomUUID();
      const rows = await applyOnDirtyRows([
        { email: ` Ada.${id}@X.com `, username: "  ada  " },
        { email: "   ", username: "   " },
      ]);
      expect(rows).toHaveLength(2);
      const byEmail = rows.find((row) => row.email !== null);
      expect(byEmail).toEqual({ email: `ada.${id}@x.com`, username: "ada" });
      expect(rows.find((row) => row.email === null)).toEqual({
        email: null,
        username: null,
      });
    });

    it("fails with a clear message when emails collide once normalized", async () => {
      const id = randomUUID();
      await expect(
        applyOnDirtyRows([
          { email: `Dup.${id}@x.com`, username: null },
          { email: ` dup.${id}@X.COM `, username: null },
        ]),
      ).rejects.toThrow(/several users share the same email/);
    });

    it("fails with a clear message when usernames collide once trimmed", async () => {
      const id = randomUUID();
      await expect(
        applyOnDirtyRows([
          { email: null, username: `dup-${id}` },
          { email: null, username: ` dup-${id} ` },
        ]),
      ).rejects.toThrow(/several users share the same username/);
    });

    it("leaves the unique indexes in place after a rolled-back run", async () => {
      const result = await client.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = current_schema() AND indexname IN ('User_email_key','User_username_key')`,
      );
      expect(result.rowCount).toBe(2);
    });
  });
});

describe("B3c S3 schema: organization update audit", () => {
  it("accepts the ORGANIZATION_UPDATED audit event type", async () => {
    const result = await client.query(
      `SELECT unnest(enum_range(NULL::"PlatformAdministrativeAuditEventType"))::text AS value`,
    );
    expect(result.rows.map((row) => row.value)).toContain(
      "ORGANIZATION_UPDATED",
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

describe("RP0-12 InvoiceEvent table (20261029000000_invoice_events)", () => {
  const MIGRATION = new URL(
    "../../prisma/migrations/20261029000000_invoice_events/migration.sql",
    import.meta.url,
  );

  it("defines the InvoiceEventType enum with INVOICE_DELETED", async () => {
    const result = await client.query(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'InvoiceEventType' ORDER BY e.enumsortorder`,
    );
    expect(result.rows.map((row) => row.enumlabel)).toEqual([
      "INVOICE_DELETED",
    ]);
  });

  it("has the columns with the expected nullability", async () => {
    const expected: Record<string, string> = {
      id: "NO",
      invoiceId: "NO",
      type: "NO",
      actorUserId: "NO",
      organizationId: "NO",
      groupId: "YES",
      createdAt: "NO",
    };
    const result = await client.query(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='InvoiceEvent'`,
    );
    const actual = Object.fromEntries(
      result.rows.map((row) => [row.column_name, row.is_nullable]),
    );
    expect(actual).toEqual(expected);
    expect(
      (await columnInfo("InvoiceEvent", "createdAt"))?.column_default,
    ).toMatch(/CURRENT_TIMESTAMP|now\(\)/i);
  });

  it("restricts the foreign keys to Invoice, User and Organization", async () => {
    const result = await client.query(
      `SELECT a.attname AS column_name, c.confrelid::regclass::text AS target, c.confdeltype AS on_delete
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.contype = 'f' AND c.conrelid = '"InvoiceEvent"'::regclass`,
    );
    const byColumn = Object.fromEntries(
      result.rows.map((row) => [row.column_name, row]),
    );
    expect(byColumn.invoiceId.target).toBe('"Invoice"');
    expect(byColumn.actorUserId.target).toBe('"User"');
    expect(byColumn.organizationId.target).toBe('"Organization"');
    for (const column of ["invoiceId", "actorUserId", "organizationId"]) {
      // 'r' is ON DELETE RESTRICT.
      expect(byColumn[column].on_delete, column).toBe("r");
    }
  });

  it("has a unique constraint on (invoiceId, type)", async () => {
    expect(await uniqueIndexColumns("InvoiceEvent")).toContainEqual([
      "invoiceId",
      "type",
    ]);
  });

  it("has an index on (organizationId, createdAt, id)", async () => {
    const result = await client.query(
      `SELECT array_agg(a.attname::text ORDER BY k.ord) AS columns
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE c.relname = 'InvoiceEvent'
        GROUP BY i.indexrelid`,
    );
    expect(result.rows.map((row) => row.columns)).toContainEqual([
      "organizationId",
      "createdAt",
      "id",
    ]);
  });

  it("can be applied again without error (idempotent)", async () => {
    await client.query(await readFile(MIGRATION, "utf8"));
  });
});

describe("invoice read indexes and scope immutability (CR-328, CR-336)", () => {
  const PARTIAL = "Invoice_organizationId_active_createdAt_id_idx";

  async function indexDefinition(name: string) {
    const result = await client.query(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'Invoice' AND indexname = $1`,
      [name],
    );
    return result.rows[0]?.indexdef as string | undefined;
  }

  it("has the partial index for the organization-wide list", async () => {
    const definition = await indexDefinition(PARTIAL);

    expect(definition).toBeDefined();
    expect(definition).toMatch(
      /\("organizationId", "createdAt" DESC, id DESC\)/,
    );
    expect(definition).toMatch(/WHERE \("deletedAt" IS NULL\)/);
  });

  it.each(["businessId", "supplierName"])(
    "has a trigram GIN index on %s",
    async (column) => {
      const definition = await indexDefinition(`Invoice_${column}_trgm_idx`);

      expect(definition).toMatch(/USING gin .*gin_trgm_ops/);
      expect(definition).toContain(`"${column}"`);
    },
  );

  it("plans the organization-wide list through the partial index", async () => {
    const creator = await createUser("planner");
    const organization = await createOrganization("org-plan");
    const group = await createGroup(organization);
    for (let n = 0; n < 5; n += 1) {
      await insertInvoice(organization, group, creator);
    }
    // Only an index that already yields the requested order can avoid the
    // (disabled) explicit sort, so the plan is deterministic on small data.
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      await client.query("SET LOCAL enable_sort = off");
      const plan = await client.query(
        `EXPLAIN (FORMAT TEXT) SELECT id FROM "Invoice"
          WHERE "organizationId" = $1 AND "deletedAt" IS NULL
          ORDER BY "createdAt" DESC, id DESC LIMIT 20`,
        [organization],
      );
      const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");

      expect(text).toContain(PARTIAL);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("plans the q search (ILIKE '%term%', 3+ characters) through the trigram indexes (CR-372)", async () => {
    const creator = await createUser("searcher");
    const organization = await createOrganization("org-search");
    const group = await createGroup(organization);
    for (let n = 0; n < 5; n += 1) {
      await insertInvoice(organization, group, creator);
    }
    // With sequential scans disabled the only way to answer the substring
    // predicates is through the GIN trigram indexes, so the plan is
    // deterministic on small data. Nothing is committed.
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query(
        `EXPLAIN (FORMAT TEXT) SELECT id FROM "Invoice"
          WHERE "businessId" ILIKE '%abc%' OR "supplierName" ILIKE '%abc%'`,
      );
      const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");

      expect(text).toContain("Bitmap Index Scan");
      expect(text).toContain("Invoice_businessId_trgm_idx");
      expect(text).toContain("Invoice_supplierName_trgm_idx");
    } finally {
      await client.query("ROLLBACK");
    }
  });

  describe("scope immutability trigger", () => {
    it.each([
      ["groupId", `"groupId" = $2, "scopeKey" = $2`],
      ["scopeKey", `"scopeKey" = 'organization'`],
      ["groupId to null", `"groupId" = NULL`],
    ])("rejects changing %s", async (_label, assignment) => {
      const creator = await createUser("scope");
      const group = await createGroup(organizationId);
      const otherGroup = await createGroup(organizationId);
      const invoice = await insertInvoice(organizationId, group, creator);

      await expect(
        client.query(
          `UPDATE "Invoice" SET ${assignment} WHERE id = $1`,
          assignment.includes("$2") ? [invoice.id, otherGroup] : [invoice.id],
        ),
      ).rejects.toMatchObject({ code: "P0001" });
    });

    it("rejects moving an invoice to another organization", async () => {
      const creator = await createUser("scope-org");
      const group = await createGroup(organizationId);
      const invoice = await insertInvoice(organizationId, group, creator);

      await expect(
        client.query(
          'UPDATE "Invoice" SET "organizationId" = $2 WHERE id = $1',
          [invoice.id, otherOrganizationId],
        ),
      ).rejects.toMatchObject({ code: "P0001" });
    });

    it("keeps insert and the deletion update working", async () => {
      const creator = await createUser("scope-ok");
      const group = await createGroup(organizationId);
      const invoice = await insertInvoice(organizationId, group, creator);

      await client.query(
        'UPDATE "Invoice" SET "deletedAt" = now(), "deletedByUserId" = $2, "supplierName" = $3 WHERE id = $1',
        [invoice.id, creator, "Renamed supplier"],
      );
      const stored = await client.query(
        'SELECT "deletedAt", "groupId" FROM "Invoice" WHERE id = $1',
        [invoice.id],
      );

      expect(stored.rows[0].deletedAt).not.toBeNull();
      expect(stored.rows[0].groupId).toBe(group);
    });
  });
});
