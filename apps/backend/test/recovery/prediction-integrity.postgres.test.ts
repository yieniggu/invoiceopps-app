import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { membershipFixtures } from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

const url = recoveryTestDatabaseUrl();
const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const app = createApp(database, auth);
const f = membershipFixtures({ prisma, client, auth, app, url });

const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";

beforeAll(async () => {
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

/** Two organizations; A has two groups, B has one. Deployments at every level. */
async function world() {
  const user = await f.makeUser("Integrity");
  const orgA = await f.makeOrg("a");
  const orgB = await f.makeOrg("b");
  const groupA1 = await f.makeGroup(orgA.id, "A1");
  const groupA2 = await f.makeGroup(orgA.id, "A2");
  const groupB = await f.makeGroup(orgB.id, "B1");

  const deployment = (organizationId: string, groupId: string | null) =>
    prisma.deployment.create({
      data: {
        organizationId,
        groupId,
        scopeKey: groupId ?? "organization",
        workspace: groupId ? `grp-${groupId}` : `org-${organizationId}`,
        registeredModel: "invoice-risk",
        version: String(Math.floor(Math.random() * 1_000_000)),
        status: "ACTIVE",
        inferenceEnabled: true,
        createdByUserId: user.id,
      },
    });
  const invoice = (organizationId: string, groupId: string | null) =>
    prisma.invoice.create({
      data: {
        organizationId,
        groupId,
        scopeKey: groupId ?? "organization",
        businessId: `FAC-${randomUUID()}`,
        supplierName: "Proveedor",
        supplierKey: "proveedor",
        amountPesos: 1000,
        currency: "CLP",
        issuedOn: new Date("2026-10-25"),
        dueOn: new Date("2026-11-25"),
        businessStatus: "PENDING",
        createdByUserId: user.id,
      },
    });

  return {
    orgA,
    orgB,
    depA: await deployment(orgA.id, null),
    depA1: await deployment(orgA.id, groupA1.id),
    depA2: await deployment(orgA.id, groupA2.id),
    depB: await deployment(orgB.id, null),
    depB1: await deployment(orgB.id, groupB.id),
    invA: await invoice(orgA.id, null),
    invA1: await invoice(orgA.id, groupA1.id),
    invB: await invoice(orgB.id, null),
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** Raw INSERT: nothing between the test and the database constraints. */
function insertPrediction(
  invoice: { id: string; organizationId: string; scopeKey: string },
  deploymentId: string,
  organizationId = invoice.organizationId,
) {
  return client.query(
    `INSERT INTO "InvoicePrediction"
       ("id","invoiceId","deploymentId","organizationId","scopeKey",
        "registeredModel","modelVersion","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'invoice-risk','3',CURRENT_TIMESTAMP)`,
    [randomUUID(), invoice.id, deploymentId, organizationId, invoice.scopeKey],
  );
}

describe("CR-500 prediction organization and scope integrity (database level)", () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });

  it("rejects a prediction that links an organization A invoice to an organization B deployment", async () => {
    await expectCode(insertPrediction(w.invA, w.depB.id), FK_VIOLATION);
    await expectCode(insertPrediction(w.invA1, w.depB1.id), FK_VIOLATION);
    await expectCode(insertPrediction(w.invB, w.depA.id), FK_VIOLATION);
  });

  it("rejects a prediction whose organizationId is that of the deployment but not of the invoice", async () => {
    // The invoice composite key (invoice, organization, scope) does not match.
    await expectCode(
      insertPrediction(w.invA, w.depB.id, w.orgB.id),
      FK_VIOLATION,
    );
  });

  it("rejects a group deployment scoring another group's invoice or an organization-level one", async () => {
    // Same organization, different group.
    await expectCode(insertPrediction(w.invA1, w.depA2.id), CHECK_VIOLATION);
    // Group deployment on an organization-level invoice.
    await expectCode(insertPrediction(w.invA, w.depA1.id), CHECK_VIOLATION);
  });

  it("accepts the legitimate pairings", async () => {
    // Group invoice: its own group's deployment and the organization's.
    await insertPrediction(w.invA1, w.depA1.id);
    await insertPrediction(w.invA1, w.depA.id);
    // Organization-level invoice: the organization's deployment.
    await insertPrediction(w.invA, w.depA.id);
    const rows = await prisma.invoicePrediction.count({
      where: { invoiceId: { in: [w.invA.id, w.invA1.id] } },
    });
    expect(rows).toBe(3);
  });

  it("also guards UPDATEs of the deployment or the scope", async () => {
    const prediction = await prisma.invoicePrediction.findFirstOrThrow({
      where: { invoiceId: w.invA1.id, deploymentId: w.depA1.id },
    });
    await expectCode(
      client.query(
        'UPDATE "InvoicePrediction" SET "deploymentId" = $1 WHERE "id" = $2',
        [w.depB.id, prediction.id],
      ),
      FK_VIOLATION,
    );
    await expectCode(
      client.query(
        'UPDATE "InvoicePrediction" SET "deploymentId" = $1 WHERE "id" = $2',
        [w.depA2.id, prediction.id],
      ),
      CHECK_VIOLATION,
    );
  });

  it("leaves a missing deployment to the foreign key", async () => {
    await expectCode(insertPrediction(w.invA, randomUUID()), FK_VIOLATION);
  });

  it("ships the intended constraints: validated composite key, no plain key, no stale unique", async () => {
    const constraints = await client.query(
      `SELECT conname, convalidated FROM pg_constraint
       WHERE conrelid = '"InvoicePrediction"'::regclass AND contype = 'f'`,
    );
    const byName = new Map<string, boolean>(
      (
        constraints.rows as Array<{ conname: string; convalidated: boolean }>
      ).map((row) => [row.conname, row.convalidated]),
    );
    expect(
      byName.get("InvoicePrediction_deploymentId_organizationId_fkey"),
    ).toBe(true);
    expect(byName.has("InvoicePrediction_deploymentId_fkey")).toBe(false);
    expect(
      byName.has("InvoicePrediction_deploymentId_organizationId_scopeKey_fkey"),
    ).toBe(false);

    const indexes = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()
       AND indexname IN ('Deployment_id_organizationId_key',
                         'Deployment_id_organizationId_scopeKey_key',
                         'Invoice_supplierKey_null_idx')`,
    );
    const indexRows = indexes.rows as Array<{
      indexname: string;
      indexdef: string;
    }>;
    const names = indexRows.map((row) => row.indexname).sort();
    expect(names).toEqual([
      "Deployment_id_organizationId_key",
      "Invoice_supplierKey_null_idx",
    ]);
    expect(
      indexRows.find((row) => row.indexname === "Invoice_supplierKey_null_idx")
        ?.indexdef,
    ).toMatch(/WHERE \(?"?supplierKey"? IS NULL\)?/);
  });
});
