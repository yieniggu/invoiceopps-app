import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recoveryTestDatabaseUrl } from "./recovery-target.js";

// Applies the real migration files, in order, to a throwaway DATABASE created
// next to the guarded test database (the reset script already needs the same
// privilege to drop and recreate it), seeds a populated database in the state
// 20261126000000 left it, and only then applies the new migration (CR-500,
// CR-506, CR-507). A separate database matters: several guards in the older
// migrations look constraints up by name across the whole database.
const MIGRATIONS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../prisma/migrations",
);
const NEW_MIGRATION = "20261127000000_prediction_integrity_and_audit";
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";

const names = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const sqlOf = (name: string) =>
  readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8");

const scratchName = `invoiceops_recovery_test_mig_${randomBytes(5).toString("hex")}`;
const url = recoveryTestDatabaseUrl();
const admin = new pg.Client({ connectionString: url });
const scratchUrl = (() => {
  const target = new URL(url);
  target.pathname = `/${scratchName}`;
  return target.toString();
})();
const client = new pg.Client({ connectionString: scratchUrl });
// Every catalog query below is scoped to this schema of the scratch database.
const schema = "public";

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

beforeAll(async () => {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${scratchName}"`);
  await client.connect();
  // Everything that existed before the new migration, applied like Prisma does.
  for (const name of names) {
    if (name >= NEW_MIGRATION) break;
    await client.query(sqlOf(name));
  }
});
afterAll(async () => {
  await client.end();
  await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.end();
});

const ids = {
  user: randomUUID(),
  orgA: randomUUID(),
  orgB: randomUUID(),
  groupA: randomUUID(),
  depOrg: randomUUID(),
  depGroup: randomUUID(),
  depB: randomUUID(),
  invOrg: randomUUID(),
  invGroup: randomUUID(),
  invNullKey: randomUUID(),
  invB: randomUUID(),
};

async function seed() {
  await client.query(
    'INSERT INTO "User" ("id","name","rut") VALUES ($1,$2,$3)',
    [ids.user, "Seed", `rut-${ids.user}`],
  );
  for (const [id, label] of [
    [ids.orgA, "a"],
    [ids.orgB, "b"],
  ] as const) {
    await client.query(
      `INSERT INTO "Organization" ("id","name","slug","mlEnabled","updatedAt")
       VALUES ($1,$2,$3,true,CURRENT_TIMESTAMP)`,
      [id, `Org ${label}`, `${label}-${id}`],
    );
  }
  await client.query(
    'INSERT INTO "Group" ("id","organizationId","name") VALUES ($1,$2,$3)',
    [ids.groupA, ids.orgA, "Group A"],
  );
  const deployment = (
    id: string,
    organizationId: string,
    groupId: string | null,
  ) =>
    client.query(
      `INSERT INTO "Deployment"
         ("id","organizationId","groupId","scopeKey","workspace","registeredModel",
          "version","status","inferenceEnabled","createdByUserId","updatedAt")
       VALUES ($1,$2,$3,$4,$5,'invoice-risk','3','ACTIVE',true,$6,CURRENT_TIMESTAMP)`,
      [
        id,
        organizationId,
        groupId,
        groupId ?? "organization",
        groupId ? `grp-${groupId}` : `org-${organizationId}`,
        ids.user,
      ],
    );
  await deployment(ids.depOrg, ids.orgA, null);
  await deployment(ids.depGroup, ids.orgA, ids.groupA);
  await deployment(ids.depB, ids.orgB, null);
  const invoice = (
    id: string,
    organizationId: string,
    groupId: string | null,
    supplierKey: string | null,
  ) =>
    client.query(
      `INSERT INTO "Invoice"
         ("id","businessId","organizationId","groupId","scopeKey","supplierName",
          "supplierKey","amountPesos","currency","issuedOn","dueOn","businessStatus",
          "createdByUserId")
       VALUES ($1,$2,$3,$4,$5,'Proveedor',$6,1000,'CLP','2026-10-25','2026-11-25',
               'PENDING',$7)`,
      [
        id,
        `FAC-${id}`,
        organizationId,
        groupId,
        groupId ?? "organization",
        supplierKey,
        ids.user,
      ],
    );
  await invoice(ids.invOrg, ids.orgA, null, "proveedor");
  await invoice(ids.invGroup, ids.orgA, ids.groupA, "proveedor");
  await invoice(ids.invNullKey, ids.orgA, null, null);
  await invoice(ids.invB, ids.orgB, null, "proveedor");
  await client.query(
    `INSERT INTO "PlatformAdministrativeAuditEvent"
       ("id","type","actorUserId","organizationId")
     VALUES ($1,'ORGANIZATION_UPDATED',$2,$3)`,
    [randomUUID(), ids.user, ids.orgA],
  );
}

const prediction = (
  invoiceId: string,
  deploymentId: string,
  organizationId: string,
  scopeKey: string,
) =>
  client.query(
    `INSERT INTO "InvoicePrediction"
       ("id","invoiceId","deploymentId","organizationId","scopeKey",
        "registeredModel","modelVersion","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'invoice-risk','3',CURRENT_TIMESTAMP)`,
    [randomUUID(), invoiceId, deploymentId, organizationId, scopeKey],
  );

const count = async (table: string) =>
  Number(
    (await client.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n,
  );

describe("migrations on a populated database (CR-500, CR-506, CR-507)", () => {
  it("the previous state really accepts a cross-organization prediction (the defect)", async () => {
    await seed();
    await prediction(ids.invOrg, ids.depOrg, ids.orgA, "organization");
    await prediction(ids.invGroup, ids.depGroup, ids.orgA, ids.groupA);
    // The legitimate 20261126 case: a group invoice scored by the org deployment.
    await prediction(ids.invGroup, ids.depOrg, ids.orgA, ids.groupA);
    await prediction(ids.invB, ids.depB, ids.orgB, "organization");
    // The defect: an organization A invoice linked to an organization B deployment.
    await prediction(ids.invOrg, ids.depB, ids.orgA, "organization");
    expect(await count("InvoicePrediction")).toBe(5);
  });

  it("refuses to apply over a violating row and leaves nothing half-applied", async () => {
    await expectCode(client.query(sqlOf(NEW_MIGRATION)), FK_VIOLATION);
    // One implicit transaction: the unique index and the new column rolled back.
    const leftovers = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = $1
       AND indexname = 'Deployment_id_organizationId_key'`,
      [schema],
    );
    expect(leftovers.rowCount).toBe(0);
    const column = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = $1
       AND table_name = 'InvoicePrediction' AND column_name = 'unavailableRetries'`,
      [schema],
    );
    expect(column.rowCount).toBe(0);
  });

  it("applies once the violating row is repaired, keeping every row", async () => {
    await client.query(
      'DELETE FROM "InvoicePrediction" WHERE "invoiceId" = $1 AND "deploymentId" = $2',
      [ids.invOrg, ids.depB],
    );
    const before = {
      predictions: await count("InvoicePrediction"),
      invoices: await count("Invoice"),
      deployments: await count("Deployment"),
      audit: await count("PlatformAdministrativeAuditEvent"),
    };

    await client.query(sqlOf(NEW_MIGRATION));

    expect({
      predictions: await count("InvoicePrediction"),
      invoices: await count("Invoice"),
      deployments: await count("Deployment"),
      audit: await count("PlatformAdministrativeAuditEvent"),
    }).toEqual(before);
    // Existing rows take the column defaults.
    const rows = await client.query(
      'SELECT DISTINCT "unavailableRetries" AS n FROM "InvoicePrediction"',
    );
    expect(rows.rows).toEqual([{ n: 0 }]);
    const audit = await client.query(
      'SELECT "mlEnabledFrom","mlEnabledTo" FROM "PlatformAdministrativeAuditEvent"',
    );
    expect(audit.rows).toEqual([{ mlEnabledFrom: null, mlEnabledTo: null }]);
  });

  it("enforces the new guarantees on the migrated data", async () => {
    await expectCode(
      prediction(ids.invOrg, ids.depB, ids.orgA, "organization"),
      FK_VIOLATION,
    );
    await expectCode(
      prediction(ids.invOrg, ids.depGroup, ids.orgA, "organization"),
      CHECK_VIOLATION,
    );
    const validated = await client.query(
      `SELECT convalidated FROM pg_constraint
       WHERE conname = 'InvoicePrediction_deploymentId_organizationId_fkey'
         AND connamespace = $1::text::regnamespace`,
      [schema],
    );
    expect(validated.rows).toEqual([{ convalidated: true }]);
  });

  it("is idempotent: applying the migration again changes nothing and fails on nothing", async () => {
    const snapshot = async () =>
      (
        await client.query(
          `SELECT
             (SELECT count(*) FROM pg_constraint WHERE connamespace = $1::text::regnamespace)::int AS constraints,
             (SELECT count(*) FROM pg_indexes WHERE schemaname = $1::text)::int AS indexes,
             (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                WHERE c.relnamespace = $1::text::regnamespace AND NOT t.tgisinternal)::int AS triggers`,
          [schema],
        )
      ).rows[0];
    const before = await snapshot();
    await client.query(sqlOf(NEW_MIGRATION));
    await client.query(sqlOf(NEW_MIGRATION));
    expect(await snapshot()).toEqual(before);
    expect(await count("InvoicePrediction")).toBe(4);
  });

  it("keeps the supplier-key-less invoice reachable through the partial index", async () => {
    const plan = await client.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1
       AND indexname = 'Invoice_supplierKey_null_idx'`,
      [schema],
    );
    expect(plan.rows).toHaveLength(1);
    const nulls = await client.query(
      'SELECT "id" FROM "Invoice" WHERE "supplierKey" IS NULL',
    );
    expect(nulls.rows).toEqual([{ id: ids.invNullKey }]);
  });
});
