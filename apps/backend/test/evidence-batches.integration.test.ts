import { PrismaPg } from "@prisma/adapter-pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { createInvoiceService } from "../src/invoices.js";
import {
  createEvidencePersistence,
  EvidenceIntegrityError,
} from "../src/evidence-persistence.js";
import {
  buildEvidenceV2Payload,
  canonicalizeEvidenceV2,
  hashEvidenceV2Bytes,
  verifyEvidenceProofV2,
} from "../src/evidence.js";
import { requireTestDatabaseUrl } from "./test-database-url.js";

const databaseUrl = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});

async function reset() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "EvidenceBatchItem", "EvidenceBatch", "EvidenceRecord"',
  );
  await prisma.decisionEvent.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.groupMembership.deleteMany();
  await prisma.group.deleteMany();
  await prisma.organizationMembership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}

beforeEach(reset);
afterAll(async () => {
  try {
    await reset();
  } finally {
    await prisma.$disconnect();
  }
});

async function fixture(owner: "user" | "group" = "user") {
  const user = await prisma.user.create({
    data: { name: "Batch actor", rut: "123456785" },
  });
  const outsider = await prisma.user.create({
    data: { name: "Other actor", rut: "123456793" },
  });
  const organization = await prisma.organization.create({
    data: { name: "Batch org", slug: "batch-org" },
  });
  await prisma.organizationMembership.create({
    data: { userId: user.id, organizationId: organization.id, role: "STUDENT" },
  });
  const group =
    owner === "group"
      ? await prisma.group.create({
          data: { organizationId: organization.id, name: "Batch group" },
        })
      : null;
  if (group)
    await prisma.groupMembership.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        groupId: group.id,
      },
    });
  const context = {
    organizationId: organization.id,
    ownerType: owner,
    ownerId: group?.id ?? user.id,
  };
  const service = createInvoiceService(prisma);
  async function evidence(index: number) {
    const invoice = await prisma.invoice.create({
      data: {
        invoiceId: `BATCH-${index}`,
        organizationId: organization.id,
        ownerType: owner === "user" ? "USER" : "GROUP",
        ownerId: context.ownerId,
        createdByUserId: user.id,
        vendorName: "Batch vendor",
        invoiceAmountCents: index + 1,
        hasPurchaseOrder: true,
        threeWayMatch: true,
        vendorTenureDays: 1,
        previousIncidents12m: 0,
        bankAccountRecentlyChanged: false,
        amountVsVendorMedian: 1,
        countryRisk: "low",
      },
    });
    await service.decideInvoice(user, context, invoice.invoiceId, {
      mode: "RULE_V1",
    });
    return prisma.evidenceRecord.findFirstOrThrow({
      where: { invoiceRecordId: invoice.id },
    });
  }
  return { user, outsider, context, evidence };
}

describe("APP-10 persisted evidence batches", () => {
  it("builds a batch from persisted records and returns a verifiable owned proof", async () => {
    const { user, context, evidence } = await fixture();
    const first = await evidence(1);
    const second = await evidence(2);
    const service = createEvidencePersistence(prisma);
    const batch = await service.createBatch(user, context, [
      second.id,
      first.id,
    ]);
    const proof = await service.getProof(user, context, batch.id, first.id);
    expect(verifyEvidenceProofV2(proof)).toBe(true);
    expect(await prisma.evidenceBatchItem.count()).toBe(2);
  });

  it("reuses an identical selection regardless of input order and permits overlapping batches", async () => {
    const { user, context, evidence } = await fixture();
    const a = await evidence(1),
      b = await evidence(2),
      c = await evidence(3);
    const service = createEvidencePersistence(prisma);
    const first = await service.createBatch(user, context, [b.id, a.id]);
    const repeated = await service.createBatch(user, context, [a.id, b.id]);
    const overlapping = await service.createBatch(user, context, [a.id, c.id]);
    expect(repeated).toEqual(first);
    expect(overlapping.id).not.toBe(first.id);
    expect(await service.getBatch(user, context, first.id)).toEqual(first);
    expect(await prisma.evidenceBatch.count()).toBe(2);
    expect(await prisma.evidenceBatchItem.count()).toBe(4);
    const proof = await service.getProof(user, context, first.id, b.id);
    expect(verifyEvidenceProofV2(proof)).toBe(true);
    for (const changed of [
      { ...proof, leafHash: "0x" + "00".repeat(32) },
      { ...proof, rootHash: "0x" + "00".repeat(32) },
      { ...proof, leafCount: 3 },
      { ...proof, leafIndex: 2 },
      { ...proof, proof: [["left", "0x" + "00".repeat(32)]] },
    ])
      expect(verifyEvidenceProofV2(changed)).toBe(false);
  });

  it("handles two concurrent identical creates without updating append-only rows", async () => {
    const { user, context, evidence } = await fixture();
    const ids = [(await evidence(1)).id, (await evidence(2)).id];
    const service = createEvidencePersistence(prisma);
    const [first, second] = await Promise.all([
      service.createBatch(user, context, ids),
      service.createBatch(user, context, ids),
    ]);
    expect(first).toEqual(second);
    expect(await prisma.evidenceBatch.count()).toBe(1);
    expect(await prisma.evidenceBatchItem.count()).toBe(2);
  });

  it("persists a full 256-leaf batch with a derived proof", async () => {
    const { user, context } = await fixture();
    const invoices = Array.from({ length: 256 }, (_, i) => ({
      id: randomUUID(),
      invoiceId: `BULK-${i}`,
      organizationId: context.organizationId,
      ownerType: "USER" as const,
      ownerId: context.ownerId,
      createdByUserId: user.id,
      vendorName: "Bulk vendor",
      invoiceAmountCents: i + 1,
      hasPurchaseOrder: true,
      threeWayMatch: true,
      vendorTenureDays: 1,
      previousIncidents12m: 0,
      bankAccountRecentlyChanged: false,
      amountVsVendorMedian: 1,
      countryRisk: "low",
    }));
    await prisma.invoice.createMany({ data: invoices });
    const events = invoices.map((invoice) => ({
      id: randomUUID(),
      invoiceId: invoice.id,
      decision: "AUTO_PROCESS",
      mode: "RULE_V1",
      ruleVersion: "invoice-rules-v1",
      actorUserId: user.id,
      actorName: user.name,
      actorRut: user.rut,
      correlationId: randomUUID(),
    }));
    await prisma.decisionEvent.createMany({ data: events });
    const persisted = await prisma.decisionEvent.findMany({
      where: { id: { in: events.map((event) => event.id) } },
    });
    const records = persisted.map((event) => {
      const canonicalPayload = Buffer.from(
        canonicalizeEvidenceV2(
          buildEvidenceV2Payload({
            event: {
              ...event,
              manualReviewThreshold: null,
              policyProbability: null,
            },
            context,
          }),
        ),
      );
      return {
        id: randomUUID(),
        decisionEventId: event.id,
        invoiceRecordId: event.invoiceId,
        organizationId: context.organizationId,
        ownerType: "USER" as const,
        ownerId: context.ownerId,
        evidenceVersion: "invoice-evidence-v2",
        canonicalVersion: "invoice-evidence-canonical-v2",
        canonicalPayload,
        leafHash: Buffer.from(
          hashEvidenceV2Bytes(canonicalPayload).slice(2),
          "hex",
        ),
      };
    });
    await prisma.evidenceRecord.createMany({ data: records });
    const service = createEvidencePersistence(prisma);
    const batch = await service.createBatch(
      user,
      context,
      records.map((record) => record.id).reverse(),
    );
    expect(batch.leafCount).toBe(256);
    expect(await prisma.evidenceBatchItem.count()).toBe(256);
    expect(
      verifyEvidenceProofV2(
        await service.getProof(user, context, batch.id, records[255].id),
      ),
    ).toBe(true);
    await expect(
      service.createBatch(user, context, [
        ...records.map((record) => record.id),
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rolls back the batch when item insertion fails and rejects a corrupt stored root", async () => {
    const { user, context, evidence } = await fixture();
    const record = await evidence(1);
    const service = createEvidencePersistence(prisma);
    try {
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION fail_batch_item_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'induced item failure'; END; $$ LANGUAGE plpgsql`,
      );
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER fail_batch_item_insert BEFORE INSERT ON "EvidenceBatchItem" FOR EACH ROW EXECUTE FUNCTION fail_batch_item_insert()',
      );
      await expect(
        service.createBatch(user, context, [record.id]),
      ).rejects.toThrow();
      expect(await prisma.evidenceBatch.count()).toBe(0);
      expect(await prisma.evidenceBatchItem.count()).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS fail_batch_item_insert ON "EvidenceBatchItem"; DROP FUNCTION IF EXISTS fail_batch_item_insert()',
      );
    }
    const corrupt = await prisma.evidenceBatch.create({
      data: {
        organizationId: context.organizationId,
        ownerType: "USER",
        ownerId: context.ownerId,
        policyVersion: "invoice-merkle-v2",
        rootHash: Buffer.alloc(32),
        leafCount: 1,
      },
    });
    await prisma.evidenceBatchItem.create({
      data: {
        batchId: corrupt.id,
        evidenceRecordId: record.id,
        organizationId: context.organizationId,
        ownerType: "USER",
        ownerId: context.ownerId,
        leafIndex: 0,
      },
    });
    await expect(
      service.getBatch(user, context, corrupt.id),
    ).rejects.toBeInstanceOf(EvidenceIntegrityError);
    await expect(
      service.getProof(user, context, corrupt.id, record.id),
    ).rejects.toBeInstanceOf(EvidenceIntegrityError);
  });

  it("rejects invalid selections and foreign owner, group, and organization contexts without writes", async () => {
    const { user, outsider, context, evidence } = await fixture("group");
    const record = await evidence(1);
    const service = createEvidencePersistence(prisma);
    for (const ids of [
      [],
      [record.id, record.id],
      Array(257).fill(record.id),
    ]) {
      await expect(
        service.createBatch(user, context, ids),
      ).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      service.createBatch(outsider, context, [record.id]),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.createBatch(user, { ...context, organizationId: outsider.id }, [
        record.id,
      ]),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.createBatch(
        user,
        { ...context, ownerType: "user", ownerId: user.id },
        [record.id],
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.createBatch(user, context, [outsider.id]),
    ).rejects.toMatchObject({ status: 404 });
    const otherGroup = await prisma.group.create({
      data: { organizationId: context.organizationId, name: "Other group" },
    });
    await prisma.groupMembership.create({
      data: {
        groupId: otherGroup.id,
        userId: user.id,
        organizationId: context.organizationId,
      },
    });
    const otherOrganization = await prisma.organization.create({
      data: { name: "Other organization", slug: "other-organization" },
    });
    await prisma.organizationMembership.create({
      data: {
        userId: user.id,
        organizationId: otherOrganization.id,
        role: "STUDENT",
      },
    });
    const contexts = [
      { ...context, ownerId: otherGroup.id },
      {
        organizationId: otherOrganization.id,
        ownerType: "user" as const,
        ownerId: user.id,
      },
    ];
    for (const [index, alternate] of contexts.entries()) {
      const invoice = await prisma.invoice.create({
        data: {
          invoiceId: `OTHER-${index}`,
          organizationId: alternate.organizationId,
          ownerType: alternate.ownerType === "group" ? "GROUP" : "USER",
          ownerId: alternate.ownerId,
          createdByUserId: user.id,
          vendorName: "Other vendor",
          invoiceAmountCents: index + 1,
          hasPurchaseOrder: true,
          threeWayMatch: true,
          vendorTenureDays: 1,
          previousIncidents12m: 0,
          bankAccountRecentlyChanged: false,
          amountVsVendorMedian: 1,
          countryRisk: "low",
        },
      });
      await createInvoiceService(prisma).decideInvoice(
        user,
        alternate,
        invoice.invoiceId,
        { mode: "RULE_V1" },
      );
      const otherRecord = await prisma.evidenceRecord.findFirstOrThrow({
        where: { invoiceRecordId: invoice.id },
      });
      await expect(
        service.createBatch(user, context, [record.id, otherRecord.id]),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.createBatch(user, alternate, [record.id, otherRecord.id]),
      ).rejects.toMatchObject({ status: 404 });
    }
    expect(await prisma.evidenceBatch.count()).toBe(0);
    const batch = await service.createBatch(user, context, [record.id]);
    await expect(
      service.getBatch(outsider, context, batch.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.getProof(user, context, batch.id, outsider.id),
    ).rejects.toMatchObject({ status: 404 });
    await prisma.groupMembership.deleteMany({ where: { userId: user.id } });
    await expect(
      service.getProof(user, context, batch.id, record.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a persisted record whose leaf digest disagrees with its original bytes", async () => {
    const { user, context, evidence } = await fixture();
    const valid = await evidence(1);
    const event = await prisma.decisionEvent.findUniqueOrThrow({
      where: { id: valid.decisionEventId },
    });
    const anotherEvent = await prisma.decisionEvent.create({
      data: {
        invoiceId: event.invoiceId,
        actorUserId: user.id,
        actorName: user.name,
        actorRut: user.rut,
        correlationId: randomUUID(),
        decision: event.decision,
        ruleVersion: event.ruleVersion,
        mode: event.mode,
      },
    });
    const invalid = await prisma.evidenceRecord.create({
      data: {
        decisionEventId: anotherEvent.id,
        evidenceVersion: valid.evidenceVersion,
        canonicalVersion: valid.canonicalVersion,
        invoiceRecordId: valid.invoiceRecordId,
        organizationId: valid.organizationId,
        ownerType: valid.ownerType,
        ownerId: valid.ownerId,
        canonicalPayload: valid.canonicalPayload,
        leafHash: Buffer.alloc(32),
      },
    });
    const service = createEvidencePersistence(prisma);
    await expect(
      service.createBatch(user, context, [invalid.id]),
    ).rejects.toBeInstanceOf(EvidenceIntegrityError);
    expect(await prisma.evidenceBatch.count()).toBe(0);
    const batch = await service.createBatch(user, context, [valid.id]);
    expect(await service.getBatch(user, context, batch.id)).toEqual(batch);
  });
});
