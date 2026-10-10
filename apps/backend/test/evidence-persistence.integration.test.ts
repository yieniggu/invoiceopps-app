import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Prisma,
  PrismaClient,
  ResourceOwnerType,
} from "../src/generated/prisma/client.js";
import {
  buildEvidenceV2Payload,
  canonicalizeEvidenceV2,
} from "../src/evidence.js";
import { requireTestDatabaseUrl } from "./test-database-url.js";

// Fail closed before creating a client or writing fixtures. The runner must
// supply an exclusive, freshly created loopback database and namespace.
const databaseUrl = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const namespace = process.env.APP10_TEST_NAMESPACE;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
let organizationId: string | undefined;
let actorId: string | undefined;
let invoiceId: string | undefined;
let recordEventId: string | undefined;
let secondRecordEventId: string | undefined;
const leaf = Buffer.alloc(32, 7);
const root = Buffer.alloc(32, 9);
const canonical = Buffer.from("{}", "utf8");

async function insertRecord(
  tx: Prisma.TransactionClient,
  overrides: {
    id?: string;
    eventId?: string;
    evidenceVersion?: string;
    canonicalVersion?: string;
    payload?: Uint8Array;
    hash?: Uint8Array;
  } = {},
) {
  const id = overrides.id ?? randomUUID();
  await tx.$executeRaw`
    INSERT INTO "EvidenceRecord" ("id", "decisionEventId", "evidenceVersion", "canonicalVersion", "invoiceRecordId", "organizationId", "ownerType", "ownerId", "canonicalPayload", "leafHash")
    VALUES (${id}, ${overrides.eventId ?? recordEventId}, ${overrides.evidenceVersion ?? "invoice-evidence-v2"}, ${overrides.canonicalVersion ?? "invoice-evidence-canonical-v2"}, ${invoiceId}, ${organizationId}, 'USER'::"ResourceOwnerType", ${actorId}, ${overrides.payload ?? canonical}, ${overrides.hash ?? leaf})
  `;
  return id;
}

async function insertBatch(
  tx: Prisma.TransactionClient,
  overrides: {
    id?: string;
    policy?: string;
    hash?: Uint8Array;
    count?: number;
  } = {},
) {
  const id = overrides.id ?? randomUUID();
  await tx.$executeRaw`
    INSERT INTO "EvidenceBatch" ("id", "organizationId", "ownerType", "ownerId", "policyVersion", "rootHash", "leafCount")
    VALUES (${id}, ${organizationId}, 'USER'::"ResourceOwnerType", ${actorId}, ${overrides.policy ?? "invoice-merkle-v2"}, ${overrides.hash ?? root}, ${overrides.count ?? 1})
  `;
  return id;
}

async function insertItem(
  tx: Prisma.TransactionClient,
  batchId: string,
  recordId: string,
  overrides: {
    organizationId?: string;
    ownerId?: string;
    leafIndex?: number;
  } = {},
) {
  await tx.$executeRaw`
    INSERT INTO "EvidenceBatchItem" ("batchId", "evidenceRecordId", "organizationId", "ownerType", "ownerId", "leafIndex")
    VALUES (${batchId}, ${recordId}, ${overrides.organizationId ?? organizationId}, 'USER'::"ResourceOwnerType", ${overrides.ownerId ?? actorId}, ${overrides.leafIndex ?? 0})
  `;
}

async function rejectsWithSqlState(
  statement: (tx: Prisma.TransactionClient) => Promise<unknown>,
  state: string,
) {
  await expect(prisma.$transaction(statement)).rejects.toMatchObject({
    code: "P2010",
    meta: { driverAdapterError: { cause: { originalCode: state } } },
  });
}

beforeAll(async () => {
  const organization = await prisma.organization.create({
    data: { name: `Evidence test ${namespace}`, slug: `evidence-${namespace}` },
  });
  organizationId = organization.id;
  const actor = await prisma.user.create({
    data: { name: "Evidence test actor", rut: "123456785" },
  });
  actorId = actor.id;
  const invoice = await prisma.invoice.create({
    data: {
      invoiceId: `INV-EVIDENCE-${namespace}`,
      organizationId: organization.id,
      ownerType: ResourceOwnerType.USER,
      ownerId: actor.id,
      createdByUserId: actor.id,
      vendorName: "Synthetic vendor",
      invoiceAmountCents: 1,
      hasPurchaseOrder: true,
      threeWayMatch: true,
      vendorTenureDays: 1,
      previousIncidents12m: 0,
      bankAccountRecentlyChanged: false,
      amountVsVendorMedian: 1,
      countryRisk: "low",
    },
  });
  invoiceId = invoice.id;
  const event = await prisma.decisionEvent.create({
    data: {
      invoiceId: invoice.id,
      actorUserId: actor.id,
      actorName: actor.name,
      actorRut: actor.rut,
      correlationId: randomUUID(),
      decision: "MANUAL_REVIEW",
      mode: "RULE_V1",
      ruleVersion: "invoice-rules-v1",
    },
  });
  recordEventId = event.id;
  const secondEvent = await prisma.decisionEvent.create({
    data: {
      invoiceId: invoice.id,
      actorUserId: actor.id,
      actorName: actor.name,
      actorRut: actor.rut,
      correlationId: randomUUID(),
      decision: "MANUAL_REVIEW",
      mode: "RULE_V1",
      ruleVersion: "invoice-rules-v1",
    },
  });
  secondRecordEventId = secondEvent.id;
});

afterAll(async () => {
  try {
    if (invoiceId) {
      // This test runs only on its guarded, new invoiceops_test database. Clear
      // rows created by concurrency tests before deleting their parent events.
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "EvidenceBatchItem", "EvidenceBatch", "EvidenceRecord"',
      );
      await prisma.decisionEvent.deleteMany({ where: { invoiceId } });
      await prisma.invoice.delete({ where: { id: invoiceId } });
    }
    if (actorId) await prisma.user.delete({ where: { id: actorId } });
    if (organizationId)
      await prisma.organization.delete({ where: { id: organizationId } });
  } finally {
    await prisma.$disconnect();
  }
});

describe("APP-10 pre-migration isolated PostgreSQL evidence", () => {
  it("reads actual Decimal and DB timestamp from pre-existing DecisionEvent rows", async () => {
    const values = [
      [null, null],
      ["0.8000", "0.8"],
      ["1e-7", "0.0000001"],
      ["0", "0"],
      ["1", "1"],
    ] as const;
    for (const [stored, expected] of values) {
      const event = await prisma.decisionEvent.create({
        data: {
          invoiceId: invoiceId!,
          actorUserId: actorId!,
          actorName: "Evidence test actor",
          actorRut: "123456785",
          correlationId: randomUUID(),
          decision: "MANUAL_REVIEW",
          mode: stored === null ? "RULE_V1" : "PROBABILITY_POLICY",
          ruleVersion: stored === null ? "invoice-rules-v1" : "ml-policy-v1",
          policyVersion: stored === null ? null : "ml-policy-v1",
          manualReviewThreshold: stored,
          policyProbability: stored,
          policyProbabilitySource: stored === null ? null : "MODEL_API",
          modelId: stored === null ? null : "invoice-review",
          modelVersion: stored === null ? null : "1",
          modelRunId: stored === null ? null : "synthetic-run",
          recommendation: stored === null ? null : "MANUAL_REVIEW",
        },
      });
      const persisted = await prisma.decisionEvent.findUniqueOrThrow({
        where: { id: event.id },
      });
      const raw = persisted.policyProbability?.toString() ?? null;
      expect(raw === null || typeof raw === "string").toBe(true);
      const payload = buildEvidenceV2Payload({
        event: {
          ...persisted,
          manualReviewThreshold:
            persisted.manualReviewThreshold?.toString() ?? null,
          policyProbability: raw,
        },
        context: {
          organizationId,
          ownerId: actorId,
          ownerType: ResourceOwnerType.USER,
        },
      });
      expect(payload).toMatchObject({
        decision_event_id: persisted.id,
        policy_probability: expected,
        manual_review_threshold: expected,
        evaluated_at: persisted.createdAt.toISOString(),
      });
      expect(persisted.createdAt).toBeInstanceOf(Date);
      expect(canonicalizeEvidenceV2(payload)).toBeInstanceOf(Uint8Array);
    }
    expect(await prisma.decisionEvent.count({ where: { invoiceId } })).toBe(
      values.length + 2,
    );
  });

  it("finds new Evidence tables in pg_catalog before exercising their constraints", async () => {
    const tables = await prisma.$queryRaw<
      Array<{ name: string; present: boolean }>
    >`
      SELECT names.name, to_regclass(format('public.%I', names.name)) IS NOT NULL AS present
      FROM (VALUES ('EvidenceRecord'), ('EvidenceBatch'), ('EvidenceBatchItem')) AS names(name)
      ORDER BY names.name
    `;
    expect(tables).toEqual([
      { name: "EvidenceBatch", present: true },
      { name: "EvidenceBatchItem", present: true },
      { name: "EvidenceRecord", present: true },
    ]);
  });

  it("exposes byte bounds, restrictive relationships and append-only triggers after migration", async () => {
    const tables = await prisma.$queryRaw<
      Array<{ name: string; present: boolean }>
    >`
      SELECT names.name, to_regclass(format('public.%I', names.name)) IS NOT NULL AS present
      FROM (VALUES ('EvidenceRecord'), ('EvidenceBatch'), ('EvidenceBatchItem')) AS names(name)
      ORDER BY names.name
    `;
    expect(
      tables.every(({ present }) => present),
      "Evidence tables must exist first",
    ).toBe(true);

    const constraints = await prisma.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      WHERE c.conrelid IN (
        to_regclass('public."EvidenceRecord"'),
        to_regclass('public."EvidenceBatch"'),
        to_regclass('public."EvidenceBatchItem"')
      )
    `;
    const definitions = constraints
      .map(({ definition }) => definition)
      .join("\n");
    expect(definitions).toContain("16384");
    expect(definitions).toMatch(/FOREIGN KEY.*ON DELETE RESTRICT/);
    expect(definitions).toContain("leafIndex");

    const triggers = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT DISTINCT c.relname AS name
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname IN
        ('EvidenceRecord', 'EvidenceBatch', 'EvidenceBatchItem', 'DecisionEvent')
    `;
    expect(triggers.map(({ name }) => name).sort()).toEqual([
      "DecisionEvent",
      "EvidenceBatch",
      "EvidenceBatchItem",
      "EvidenceRecord",
    ]);
  });

  it("preserves an older decision without manufacturing Evidence", async () => {
    const legacyId = process.env.APP10_LEGACY_EVENT_ID;
    expect(legacyId).toMatch(/^[0-9a-f-]{36}$/);
    const legacy = await prisma.decisionEvent.findUniqueOrThrow({
      where: { id: legacyId },
    });
    expect(legacy).toMatchObject({
      id: legacyId,
      decision: "MANUAL_REVIEW",
      ruleVersion: "invoice-rules-v1",
    });
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM "EvidenceRecord" WHERE "decisionEventId" = ${legacyId}
    `;
    expect(rows[0].count).toBe(0n);
  });

  it("rejects invalid EvidenceRecord lengths, versions, FK and duplicate event/version", async () => {
    for (const hash of [Buffer.alloc(31), Buffer.alloc(33)]) {
      await rejectsWithSqlState((tx) => insertRecord(tx, { hash }), "23514");
    }
    for (const payload of [Buffer.alloc(0), Buffer.alloc(16385)]) {
      await rejectsWithSqlState((tx) => insertRecord(tx, { payload }), "23514");
    }
    await rejectsWithSqlState(
      (tx) => insertRecord(tx, { evidenceVersion: "invoice-evidence-v1" }),
      "23514",
    );
    await rejectsWithSqlState(
      (tx) => insertRecord(tx, { canonicalVersion: "invalid" }),
      "23514",
    );
    await rejectsWithSqlState(
      (tx) => insertRecord(tx, { eventId: randomUUID() }),
      "23503",
    );
    await rejectsWithSqlState(async (tx) => {
      await insertRecord(tx);
      await insertRecord(tx);
    }, "23505");
  });

  it("rejects invalid EvidenceBatch root, count, policy and duplicate context/root", async () => {
    for (const hash of [Buffer.alloc(31), Buffer.alloc(33)]) {
      await rejectsWithSqlState((tx) => insertBatch(tx, { hash }), "23514");
    }
    for (const count of [0, 257]) {
      await rejectsWithSqlState((tx) => insertBatch(tx, { count }), "23514");
    }
    await rejectsWithSqlState(
      (tx) => insertBatch(tx, { policy: "invoice-merkle-v1" }),
      "23514",
    );
    await rejectsWithSqlState(async (tx) => {
      await insertBatch(tx);
      await insertBatch(tx);
    }, "23505");
  });

  it("enforces EvidenceBatchItem composite ownership, references, positions and uniqueness", async () => {
    for (const overrides of [
      { ownerId: randomUUID() },
      { organizationId: randomUUID() },
    ]) {
      await rejectsWithSqlState(async (tx) => {
        const recordId = await insertRecord(tx);
        const batchId = await insertBatch(tx);
        await insertItem(tx, batchId, recordId, overrides);
      }, "23503");
    }
    await rejectsWithSqlState(async (tx) => {
      const recordId = await insertRecord(tx);
      await insertItem(tx, randomUUID(), recordId);
    }, "23503");
    await rejectsWithSqlState(async (tx) => {
      const batchId = await insertBatch(tx);
      await insertItem(tx, batchId, randomUUID());
    }, "23503");
    for (const leafIndex of [-1, 256]) {
      await rejectsWithSqlState(async (tx) => {
        const recordId = await insertRecord(tx);
        const batchId = await insertBatch(tx);
        await insertItem(tx, batchId, recordId, { leafIndex });
      }, "23514");
    }
    await rejectsWithSqlState(async (tx) => {
      const recordId = await insertRecord(tx);
      const otherRecordId = await insertRecord(tx, {
        eventId: secondRecordEventId,
        hash: Buffer.alloc(32, 8),
      });
      const batchId = await insertBatch(tx);
      await insertItem(tx, batchId, recordId);
      await insertItem(tx, batchId, otherRecordId);
    }, "23505");
    await rejectsWithSqlState(async (tx) => {
      const recordId = await insertRecord(tx);
      const batchId = await insertBatch(tx);
      await insertItem(tx, batchId, recordId);
      await insertItem(tx, batchId, recordId, { leafIndex: 1 });
    }, "23505");
  });

  it("rejects Evidence mutation and protects only decisions linked to Evidence", async () => {
    const cases = [
      async (tx: Prisma.TransactionClient, recordId: string) => {
        await tx.$executeRaw`UPDATE "EvidenceRecord" SET "ownerId" = ${randomUUID()} WHERE "id" = ${recordId}`;
      },
      async (tx: Prisma.TransactionClient, recordId: string) => {
        await tx.$executeRaw`DELETE FROM "EvidenceRecord" WHERE "id" = ${recordId}`;
      },
      async (
        tx: Prisma.TransactionClient,
        _recordId: string,
        batchId: string,
      ) => {
        await tx.$executeRaw`UPDATE "EvidenceBatch" SET "leafCount" = 2 WHERE "id" = ${batchId}`;
      },
      async (
        tx: Prisma.TransactionClient,
        _recordId: string,
        batchId: string,
      ) => {
        await tx.$executeRaw`DELETE FROM "EvidenceBatch" WHERE "id" = ${batchId}`;
      },
      async (
        tx: Prisma.TransactionClient,
        _recordId: string,
        batchId: string,
      ) => {
        await tx.$executeRaw`UPDATE "EvidenceBatchItem" SET "leafIndex" = 1 WHERE "batchId" = ${batchId}`;
      },
      async (
        tx: Prisma.TransactionClient,
        _recordId: string,
        batchId: string,
      ) => {
        await tx.$executeRaw`DELETE FROM "EvidenceBatchItem" WHERE "batchId" = ${batchId}`;
      },
      async (tx: Prisma.TransactionClient) => {
        await tx.$executeRaw`UPDATE "DecisionEvent" SET "ruleVersion" = 'altered' WHERE "id" = ${recordEventId}`;
      },
      async (tx: Prisma.TransactionClient) => {
        await tx.$executeRaw`DELETE FROM "DecisionEvent" WHERE "id" = ${recordEventId}`;
      },
    ];
    for (const mutate of cases) {
      await rejectsWithSqlState(async (tx) => {
        const recordId = await insertRecord(tx);
        const batchId = await insertBatch(tx);
        await insertItem(tx, batchId, recordId);
        await mutate(tx, recordId, batchId);
      }, "P0001");
    }

    const legacyId = process.env.APP10_LEGACY_EVENT_ID!;
    const before = await prisma.decisionEvent.findUniqueOrThrow({
      where: { id: legacyId },
    });
    const changedRuleVersion = "invoice-rules-v1-compat-test";
    expect(before.ruleVersion).not.toBe(changedRuleVersion);
    try {
      await prisma.$transaction(async (tx) => {
        const modified = await tx.$executeRaw`
          UPDATE "DecisionEvent" SET "ruleVersion" = ${changedRuleVersion} WHERE "id" = ${legacyId}
        `;
        expect(modified).toBe(1);
        const deletable = await tx.decisionEvent.create({
          data: {
            invoiceId: invoiceId!,
            actorUserId: actorId!,
            actorName: "Evidence test actor",
            actorRut: "123456785",
            correlationId: randomUUID(),
            decision: "MANUAL_REVIEW",
            mode: "RULE_V1",
            ruleVersion: "invoice-rules-v1",
          },
        });
        expect(
          await tx.decisionEvent.delete({ where: { id: deletable.id } }),
        ).toMatchObject({ id: deletable.id });
      });
      const persisted = await prisma.decisionEvent.findUniqueOrThrow({
        where: { id: legacyId },
      });
      expect(persisted.ruleVersion).toBe(changedRuleVersion);
    } finally {
      const current = await prisma.decisionEvent.findUniqueOrThrow({
        where: { id: legacyId },
      });
      if (current.ruleVersion !== before.ruleVersion) {
        await prisma.decisionEvent.update({
          where: { id: legacyId },
          data: { ruleVersion: before.ruleVersion },
        });
      }
    }
  });

  it("serializes an uncommitted Evidence insert before a non-key event update", async () => {
    let releaseHolder = () => {};
    let inserted = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const insertStarted = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const updater = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    const appName = `app10-update-${namespace}`;
    const holder = prisma.$transaction(
      async (tx) => {
        await insertRecord(tx);
        inserted();
        await hold;
      },
      { timeout: 15000 },
    );
    let updateTask: Promise<{ ok: boolean; error?: unknown }> | undefined;
    try {
      await Promise.race([
        insertStarted,
        holder.then(() => {
          throw new Error("Holder committed before release");
        }),
      ]);
      updateTask = updater
        .$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT set_config('application_name', ${appName}, true)`;
            await tx.$queryRaw`SELECT set_config('lock_timeout', '6s', true)`;
            await tx.$executeRaw`UPDATE "DecisionEvent" SET "ruleVersion" = 'altered' WHERE "id" = ${recordEventId}`;
          },
          { timeout: 15000 },
        )
        .then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
      let blocked = false;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !blocked) {
        const observation = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND application_name = ${appName}
              AND wait_event_type = 'Lock' AND state = 'active'
          ) AS blocked
        `;
        blocked = observation[0].blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(
        blocked,
        "Updater must be observed waiting on the parent row",
      ).toBe(true);
      releaseHolder();
      await holder;
      const outcome = await updateTask;
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatchObject({
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "P0001" } } },
      });
    } finally {
      releaseHolder();
      await Promise.allSettled([holder, updateTask]);
      await updater.$disconnect();
    }
  });

  it("makes an older REPEATABLE READ event writer fail closed after Evidence commits", async () => {
    const older = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    let releaseSnapshot = () => {};
    let snapshotStarted = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const observed = new Promise<void>((resolve) => {
      snapshotStarted = resolve;
    });
    const oldWriter = older
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "DecisionEvent" WHERE "id" = ${secondRecordEventId}`;
          snapshotStarted();
          await hold;
          await tx.$executeRaw`UPDATE "DecisionEvent" SET "ruleVersion" = 'altered' WHERE "id" = ${secondRecordEventId}`;
        },
        { isolationLevel: "RepeatableRead", timeout: 15000 },
      )
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    try {
      await Promise.race([
        observed,
        oldWriter.then(() => {
          throw new Error("Old writer finished before snapshot was observed");
        }),
      ]);
      await prisma.$transaction(async (tx) => {
        await insertRecord(tx, {
          eventId: secondRecordEventId,
          hash: Buffer.alloc(32, 8),
        });
      });
      releaseSnapshot();
      const outcome = await oldWriter;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Old writer changed an evidenced event");
      const failure = outcome.error as {
        code?: string;
        meta?: {
          driverAdapterError?: { cause?: { originalCode?: string } };
        };
      };
      expect(["40001", "P0001", "P2034"]).toContain(
        failure.meta?.driverAdapterError?.cause?.originalCode ?? failure.code,
      );
    } finally {
      releaseSnapshot();
      await Promise.allSettled([oldWriter]);
      await older.$disconnect();
    }
  });
});
