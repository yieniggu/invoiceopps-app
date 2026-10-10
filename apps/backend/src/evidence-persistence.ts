import { randomUUID } from "node:crypto";

import { AuthError, type AuthUser } from "./auth.js";
import { type PrismaClient } from "./generated/prisma/client.js";
import type { ResourceContext } from "./resources.js";
import { authorizeContext, ownerType } from "./invoices.js";
import {
  buildEvidenceBatchV2,
  buildEvidenceV2Payload,
  canonicalizeEvidenceV2,
  hashEvidenceV2Bytes,
} from "./evidence.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function inaccessible() {
  return new AuthError(404, "Invoice not found");
}

export class EvidenceIntegrityError extends Error {
  constructor() {
    super("Evidence integrity verification failed");
  }
}

type RecordWithSource = NonNullable<
  Awaited<ReturnType<PrismaClient["evidenceRecord"]["findFirst"]>>
> & {
  decisionEvent: {
    id: string;
    invoiceId: string;
    correlationId: string;
    createdAt: Date;
    decision: string;
    ruleVersion: string;
    mode: string;
    policyVersion: string | null;
    manualReviewThreshold: { toString(): string } | null;
    policyProbability: { toString(): string } | null;
    policyProbabilitySource: string | null;
    modelId: string | null;
    modelVersion: string | null;
    modelRunId: string | null;
    recommendation: string | null;
    invoice: {
      id: string;
      organizationId: string;
      ownerType: string;
      ownerId: string;
    };
  };
};

const source = { decisionEvent: { include: { invoice: true } } } as const;

function verifyRecord(record: RecordWithSource, context: ResourceContext) {
  try {
    const event = record.decisionEvent;
    const invoice = event.invoice;
    if (
      record.evidenceVersion !== "invoice-evidence-v2" ||
      record.canonicalVersion !== "invoice-evidence-canonical-v2" ||
      record.decisionEventId !== event.id ||
      record.invoiceRecordId !== event.invoiceId ||
      event.invoiceId !== invoice.id ||
      record.organizationId !== context.organizationId ||
      record.ownerType !== ownerType(context.ownerType) ||
      record.ownerId !== context.ownerId ||
      invoice.organizationId !== context.organizationId ||
      invoice.ownerType !== record.ownerType ||
      invoice.ownerId !== context.ownerId ||
      record.canonicalPayload.length < 1 ||
      record.canonicalPayload.length > 16384 ||
      record.leafHash.length !== 32
    )
      throw new EvidenceIntegrityError();
    // Rebuilding from the persisted event also rejects unknown keys, invalid UTF-8,
    // noncanonical JSON, stale invoice context, and mismatched payload linkage.
    const bytes = canonicalizeEvidenceV2(
      buildEvidenceV2Payload({
        event: {
          ...event,
          manualReviewThreshold:
            event.manualReviewThreshold?.toString() ?? null,
          policyProbability: event.policyProbability?.toString() ?? null,
        },
        context: {
          organizationId: record.organizationId,
          ownerType: record.ownerType,
          ownerId: record.ownerId,
        },
      }),
    );
    const hash = hashEvidenceV2Bytes(bytes);
    if (
      !Buffer.from(record.canonicalPayload).equals(Buffer.from(bytes)) ||
      !Buffer.from(record.leafHash).equals(Buffer.from(hash.slice(2), "hex"))
    )
      throw new EvidenceIntegrityError();
    return {
      decisionEventId: event.id,
      leafHash: hash,
      organizationId: context.organizationId,
      ownerType: context.ownerType,
      ownerId: context.ownerId,
    };
  } catch {
    throw new EvidenceIntegrityError();
  }
}

function summary(batch: {
  id: string;
  rootHash: Uint8Array;
  leafCount: number;
  policyVersion: string;
}) {
  return {
    id: batch.id,
    rootHash: `0x${Buffer.from(batch.rootHash).toString("hex")}`,
    leafCount: batch.leafCount,
    policyVersion: batch.policyVersion,
  };
}

export function createEvidencePersistence(prisma: PrismaClient) {
  async function readBatch(
    db: Pick<PrismaClient, "evidenceBatch">,
    context: ResourceContext,
    batchId: string,
  ) {
    const batch = await db.evidenceBatch.findFirst({
      where: {
        id: batchId,
        organizationId: context.organizationId,
        ownerType: ownerType(context.ownerType),
        ownerId: context.ownerId,
      },
      include: {
        items: {
          orderBy: { leafIndex: "asc" },
          include: { evidenceRecord: { include: source } },
        },
      },
    });
    if (!batch) throw inaccessible();
    if (
      batch.leafCount < 1 ||
      batch.leafCount > 256 ||
      batch.items.length !== batch.leafCount
    )
      throw new EvidenceIntegrityError();
    const ids = new Set<string>();
    const items = batch.items.map((item, index) => {
      if (
        item.leafIndex !== index ||
        ids.has(item.evidenceRecordId) ||
        item.batchId !== batch.id ||
        item.organizationId !== context.organizationId ||
        item.ownerType !== batch.ownerType ||
        item.ownerId !== context.ownerId ||
        item.evidenceRecordId !== item.evidenceRecord.id
      )
        throw new EvidenceIntegrityError();
      ids.add(item.evidenceRecordId);
      return verifyRecord(item.evidenceRecord, context);
    });
    let rebuilt;
    try {
      rebuilt = buildEvidenceBatchV2(items);
    } catch {
      throw new EvidenceIntegrityError();
    }
    if (
      rebuilt.policyVersion !== batch.policyVersion ||
      rebuilt.leafCount !== batch.leafCount ||
      rebuilt.rootHash !== `0x${Buffer.from(batch.rootHash).toString("hex")}` ||
      rebuilt.items.some(
        (item, index) => item.decisionEventId !== items[index].decisionEventId,
      )
    )
      throw new EvidenceIntegrityError();
    return { batch: summary(batch), items: batch.items, rebuilt };
  }

  return {
    async createBatch(
      actor: AuthUser,
      context: ResourceContext,
      recordIds: string[],
    ) {
      if (
        !Array.isArray(recordIds) ||
        recordIds.length < 1 ||
        recordIds.length > 256 ||
        recordIds.some((id) => typeof id !== "string" || !UUID.test(id)) ||
        new Set(recordIds).size !== recordIds.length
      )
        throw new AuthError(400, "Invalid evidence selection");
      try {
        return await prisma.$transaction(async (tx) => {
          await authorizeContext(tx, actor.id, context);
          const records = await tx.evidenceRecord.findMany({
            where: {
              id: { in: recordIds },
              organizationId: context.organizationId,
              ownerType: ownerType(context.ownerType),
              ownerId: context.ownerId,
            },
            include: source,
            take: 256,
          });
          if (records.length !== recordIds.length) throw inaccessible();
          const byId = new Map(records.map((record) => [record.id, record]));
          const selected = recordIds.map((id) =>
            verifyRecord(byId.get(id)!, context),
          );
          let built;
          try {
            built = buildEvidenceBatchV2(selected);
          } catch {
            throw new EvidenceIntegrityError();
          }
          const id = randomUUID();
          const rootHash = Buffer.from(built.rootHash.slice(2), "hex");
          const owner = {
            organizationId: context.organizationId,
            ownerType: ownerType(context.ownerType),
            ownerId: context.ownerId,
          };
          const created = await tx.evidenceBatch.createMany({
            data: [
              {
                id,
                ...owner,
                rootHash,
                leafCount: built.leafCount,
                policyVersion: built.policyVersion,
              },
            ],
            skipDuplicates: true,
          });
          const batch = await tx.evidenceBatch.findFirstOrThrow({
            where: { ...owner, rootHash, policyVersion: built.policyVersion },
          });
          if (created.count === 1) {
            const recordByEvent = new Map(
              records.map((record) => [record.decisionEventId, record.id]),
            );
            await tx.evidenceBatchItem.createMany({
              data: built.items.map((item) => ({
                batchId: batch.id,
                evidenceRecordId: recordByEvent.get(item.decisionEventId)!,
                ...owner,
                leafIndex: item.leafIndex,
              })),
            });
          }
          const stored = await readBatch(tx, context, batch.id);
          if (
            stored.items.length !== recordIds.length ||
            stored.items.some((item) => !byId.has(item.evidenceRecordId))
          )
            throw new EvidenceIntegrityError();
          return stored.batch;
        });
      } catch (error) {
        if (
          error instanceof AuthError ||
          error instanceof EvidenceIntegrityError
        )
          throw error;
        throw new EvidenceIntegrityError();
      }
    },
    async getBatch(actor: AuthUser, context: ResourceContext, batchId: string) {
      await authorizeContext(prisma, actor.id, context);
      return (await readBatch(prisma, context, batchId)).batch;
    },
    async getProof(
      actor: AuthUser,
      context: ResourceContext,
      batchId: string,
      recordId: string,
    ) {
      await authorizeContext(prisma, actor.id, context);
      const { batch, items, rebuilt } = await readBatch(
        prisma,
        context,
        batchId,
      );
      const index = items.findIndex(
        (item) => item.evidenceRecordId === recordId,
      );
      if (index < 0) throw inaccessible();
      return {
        leafHash: rebuilt.items[index].leafHash,
        rootHash: batch.rootHash,
        leafIndex: index,
        leafCount: batch.leafCount,
        policyVersion: batch.policyVersion,
        proof: rebuilt.items[index].proof,
      };
    },
  };
}
