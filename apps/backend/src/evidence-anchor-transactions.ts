import { AuthError, type AuthUser } from "./auth.js";
import type {
  EvidenceAnchorTarget,
  PreparedAnchorTransaction,
} from "./evidence-anchor-client.js";
import { createEvidencePersistence } from "./evidence-persistence.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { authorizeContext, ownerType } from "./invoices.js";
import type { ResourceContext } from "./resources.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function createEvidenceAnchorTransactions(prisma: PrismaClient) {
  const evidence = createEvidencePersistence(prisma);
  async function verify(
    actor: AuthUser,
    context: ResourceContext,
    batchId: string,
    root: string,
  ) {
    const batch = await evidence.getBatch(actor, context, batchId);
    if (batch.rootHash !== root.toLowerCase())
      throw new AuthError(404, "Evidence batch not found");
    return batch;
  }
  return {
    async acquireSignerPreparationSlot(
      actor: AuthUser,
      context: ResourceContext,
      batchId: string,
      root: string,
      target: EvidenceAnchorTarget,
      reservationId: string,
      claimToken: string,
      signerAddress: string,
    ): Promise<void> {
      const batch = await verify(actor, context, batchId, root);
      if (
        !ADDRESS.test(signerAddress) ||
        !ADDRESS.test(target.contractAddress) ||
        !Number.isSafeInteger(target.chainId) ||
        target.chainId <= 0 ||
        !reservationId ||
        !claimToken
      )
        throw new AuthError(400, "Invalid signer slot intent");
      const inserted = await prisma.$transaction(async (tx) => {
        await authorizeContext(tx, actor.id, context);
        return tx.$queryRaw<{ reservationId: string }[]>`
          INSERT INTO "EvidenceSignerPreparationSlot" ("chainId", "signerAddress", "reservationId", "contractAddress", "rootHash", "batchId", "organizationId", "ownerType", "ownerId", "actorUserId")
          SELECT r."chainId", ${Buffer.from(signerAddress.slice(2), "hex")}, r."id", r."contractAddress", r."rootHash", r."batchId", r."organizationId", r."ownerType", r."ownerId", r."actorUserId"
          FROM "EvidenceAnchorReservation" r
          WHERE r."id" = ${reservationId} AND r."claimToken" = ${claimToken}
            AND r."batchId" = ${batch.id} AND r."organizationId" = ${context.organizationId}
            AND r."ownerType" = ${ownerType(context.ownerType)}::"ResourceOwnerType"
            AND r."ownerId" = ${context.ownerId} AND r."actorUserId" = ${actor.id}
            AND r."chainId" = ${BigInt(target.chainId)} AND r."contractAddress" = ${Buffer.from(target.contractAddress.slice(2), "hex")}
            AND r."rootHash" = ${Buffer.from(root.slice(2), "hex")} AND r."state" = 'RESERVED'
          ON CONFLICT DO NOTHING RETURNING "reservationId"
        `;
      });
      if (inserted.length !== 1)
        throw new Error(
          "Signer preparation slot unavailable or reservation mismatch",
        );
    },
    async persistPreparedTransaction(
      actor: AuthUser,
      context: ResourceContext,
      batchId: string,
      reservationId: string,
      claimToken: string,
      prepared: Omit<PreparedAnchorTransaction, "signedTransaction">,
    ): Promise<void> {
      const batch = await verify(actor, context, batchId, prepared.root);
      if (
        !ADDRESS.test(prepared.signerAddress) ||
        !ADDRESS.test(prepared.contractAddress) ||
        !HASH.test(prepared.transactionHash) ||
        !Number.isSafeInteger(prepared.chainId) ||
        prepared.chainId <= 0 ||
        !Number.isSafeInteger(prepared.nonce) ||
        prepared.nonce < 0 ||
        prepared.gas < 21_000n ||
        prepared.gas > 3_000_000n ||
        prepared.maxFeePerGas <= 0n ||
        prepared.maxFeePerGas > 1_000_000_000_000n ||
        prepared.maxPriorityFeePerGas < 0n ||
        prepared.maxPriorityFeePerGas > prepared.maxFeePerGas
      )
        throw new AuthError(400, "Invalid prepared evidence metadata");
      const inserted = await prisma.$transaction(async (tx) => {
        await authorizeContext(tx, actor.id, context);
        return tx.$queryRaw<{ reservationId: string }[]>`
          INSERT INTO "EvidencePreparedAnchorTransaction" ("reservationId", "chainId", "signerAddress", "contractAddress", "rootHash", "nonce", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "transactionHash")
          SELECT r."id", r."chainId", s."signerAddress", r."contractAddress", r."rootHash", ${BigInt(prepared.nonce)}, ${prepared.gas}, ${prepared.maxFeePerGas}, ${prepared.maxPriorityFeePerGas}, ${Buffer.from(prepared.transactionHash.slice(2), "hex")}
          FROM "EvidenceAnchorReservation" r
          JOIN "EvidenceSignerPreparationSlot" s ON s."reservationId" = r."id"
          WHERE r."id" = ${reservationId} AND r."claimToken" = ${claimToken}
            AND r."batchId" = ${batch.id} AND r."organizationId" = ${context.organizationId}
            AND r."ownerType" = ${ownerType(context.ownerType)}::"ResourceOwnerType"
            AND r."ownerId" = ${context.ownerId} AND r."actorUserId" = ${actor.id}
            AND r."chainId" = ${BigInt(prepared.chainId)}
            AND r."contractAddress" = ${Buffer.from(prepared.contractAddress.slice(2), "hex")}
            AND r."rootHash" = ${Buffer.from(prepared.root.slice(2), "hex")}
            AND s."signerAddress" = ${Buffer.from(prepared.signerAddress.slice(2), "hex")}
            AND r."state" = 'RESERVED'
          ON CONFLICT DO NOTHING RETURNING "reservationId"
        `;
      });
      if (inserted.length !== 1)
        throw new Error(
          "Prepared transaction unavailable or reservation mismatch",
        );
    },
  };
}
