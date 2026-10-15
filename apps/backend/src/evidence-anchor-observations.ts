import { randomUUID } from "node:crypto";

import { AuthError, type AuthUser } from "./auth.js";
import type {
  AnchorObservation,
  ObservationKind,
  StoredAnchor,
} from "./evidence-anchor-reconciliation.js";
import { createEvidencePersistence } from "./evidence-persistence.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { authorizeContext, ownerType } from "./invoices.js";
import type { ResourceContext } from "./resources.js";

const inaccessible = () => new AuthError(404, "Evidence batch not found");
const hex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;

export function createEvidenceAnchorObservations(prisma: PrismaClient) {
  const evidence = createEvidencePersistence(prisma);
  async function readPrepared(
    actor: AuthUser,
    context: ResourceContext,
    batchId: string,
    reservationId: string,
  ): Promise<StoredAnchor> {
    const batch = await evidence.getBatch(actor, context, batchId);
    const prepared = await prisma.evidencePreparedAnchorTransaction.findFirst({
      where: {
        reservationId,
        reservation: {
          batchId: batch.id,
          organizationId: context.organizationId,
          ownerType: ownerType(context.ownerType),
          ownerId: context.ownerId,
        },
      },
    });
    if (
      !prepared ||
      hex(prepared.rootHash) !== batch.rootHash ||
      prepared.chainId < 1n ||
      prepared.chainId > BigInt(Number.MAX_SAFE_INTEGER) ||
      prepared.nonce < 0n ||
      prepared.nonce > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw inaccessible();
    return {
      reservationId,
      chainId: Number(prepared.chainId),
      signerAddress: hex(prepared.signerAddress),
      contractAddress: hex(prepared.contractAddress),
      rootHash: hex(prepared.rootHash),
      transactionHash: hex(prepared.transactionHash),
      nonce: prepared.nonce,
      gas: prepared.gas,
      maxFeePerGas: prepared.maxFeePerGas,
      maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
    };
  }
  return {
    readPrepared,
    async latest(
      actor: AuthUser,
      context: ResourceContext,
      batchId: string,
      reservationId: string,
    ): Promise<ObservationKind | null> {
      await readPrepared(actor, context, batchId, reservationId);
      const row = await prisma.evidenceAnchorObservation.findFirst({
        where: {
          reservationId,
          kind: { in: ["observedSuccess", "observedRevert", "orphaned"] },
        },
        orderBy: [{ checkedAt: "desc" }, { id: "desc" }],
        select: { kind: true },
      });
      if (!row) return null;
      if (
        [
          "pending",
          "needsReview",
          "orphaned",
          "observedRevert",
          "observedSuccess",
        ].includes(row.kind)
      )
        return row.kind as ObservationKind;
      throw new Error("Invalid persisted evidence observation");
    },
    async append(
      actor: AuthUser,
      context: ResourceContext,
      batchId: string,
      reservationId: string,
      observation: AnchorObservation,
    ): Promise<AnchorObservation> {
      // Reconstruct and reauthorize after RPC; no SQL transaction spans the provider call.
      const batch = await evidence.getBatch(actor, context, batchId);
      const inserted = await prisma.$transaction(async (tx) => {
        await authorizeContext(tx, actor.id, context);
        return tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "EvidenceAnchorObservation"
            ("id", "reservationId", "actorUserId", "chainId", "signerAddress", "contractAddress", "rootHash", "transactionHash", "kind", "reason", "blockNumber", "blockHash", "receiptStatus")
          SELECT ${randomUUID()}, p."reservationId", ${actor.id}, p."chainId", p."signerAddress", p."contractAddress", p."rootHash", p."transactionHash",
            ${observation.kind}, ${observation.reason}, ${observation.blockNumber ?? null},
            ${observation.blockHash ? Buffer.from(observation.blockHash.slice(2), "hex") : null}, ${observation.receiptStatus ?? null}
          FROM "EvidencePreparedAnchorTransaction" p
          JOIN "EvidenceAnchorReservation" r ON r."id" = p."reservationId"
          WHERE p."reservationId" = ${reservationId} AND r."batchId" = ${batch.id}
            AND r."organizationId" = ${context.organizationId}
            AND r."ownerType" = ${ownerType(context.ownerType)}::"ResourceOwnerType"
            AND r."ownerId" = ${context.ownerId} AND p."rootHash" = ${Buffer.from(batch.rootHash.slice(2), "hex")}
          RETURNING "id"
        `;
      });
      if (inserted.length !== 1) throw inaccessible();
      return observation;
    },
  };
}
