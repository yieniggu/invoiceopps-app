import type { AuthUser } from "./auth.js";
import type { createEvidenceAnchorClient } from "./evidence-anchor-client.js";
import type { AnchorClaimResult } from "./evidence-anchor-reservation.js";
import type { createEvidencePersistence } from "./evidence-persistence.js";
import type { ResourceContext } from "./resources.js";
import type { PreparedAnchorTransaction } from "./evidence-anchor-client.js";

type EvidenceBatchReader = Pick<
  ReturnType<typeof createEvidencePersistence>,
  "getBatch"
>;

interface DurableSubmissionClaim {
  // Must atomically persist an exclusive claim before any send; an ambiguous
  // outcome remains claimed until separately reconciled, including after restart.
  claimAnchorSubmission(
    actor: AuthUser,
    context: ResourceContext,
    batchId: string,
    root: string,
    target: ReturnType<
      ReturnType<typeof createEvidenceAnchorClient>["getTarget"]
    >,
  ): Promise<AnchorClaimResult>;
  acquireSignerPreparationSlot(
    actor: AuthUser,
    context: ResourceContext,
    batchId: string,
    root: string,
    target: { chainId: number; contractAddress: string },
    reservationId: string,
    claimToken: string,
    signerAddress: string,
  ): Promise<void>;
  persistPreparedTransaction(
    actor: AuthUser,
    context: ResourceContext,
    batchId: string,
    reservationId: string,
    claimToken: string,
    prepared: Omit<PreparedAnchorTransaction, "signedTransaction">,
  ): Promise<void>;
}

export function createEvidenceAnchor(
  persistence: EvidenceBatchReader & Partial<DurableSubmissionClaim>,
  client: ReturnType<typeof createEvidenceAnchorClient>,
) {
  return {
    async anchorBatch(
      actor: AuthUser,
      context: ResourceContext,
      batchId: string,
    ): Promise<"alreadyRegistered" | "broadcastedUnknown"> {
      const batch = await persistence.getBatch(actor, context, batchId);
      if (await client.isRootRegistered(batch.rootHash)) {
        return "alreadyRegistered";
      }
      if (!persistence.claimAnchorSubmission) {
        throw new Error("Durable evidence anchor submission claim unavailable");
      }
      const claimed = await persistence.claimAnchorSubmission(
        actor,
        context,
        batchId,
        batch.rootHash,
        client.getTarget(),
      );
      if (
        claimed?.kind !== "acquired" ||
        typeof claimed.reservationId !== "string" ||
        !claimed.reservationId ||
        typeof claimed.claimToken !== "string" ||
        !claimed.claimToken
      ) {
        throw new Error("Evidence anchor submission already claimed");
      }
      if (
        !persistence.acquireSignerPreparationSlot ||
        !persistence.persistPreparedTransaction
      ) {
        throw new Error("Durable evidence transaction preparation unavailable");
      }
      await persistence.acquireSignerPreparationSlot(
        actor,
        context,
        batchId,
        batch.rootHash,
        client.getTarget(),
        claimed.reservationId,
        claimed.claimToken,
        client.getSigner(),
      );
      const prepared = await client.prepareRootRegistration(batch.rootHash);
      const metadata = {
        chainId: prepared.chainId,
        contractAddress: prepared.contractAddress,
        signerAddress: prepared.signerAddress,
        root: prepared.root,
        nonce: prepared.nonce,
        gas: prepared.gas,
        maxFeePerGas: prepared.maxFeePerGas,
        maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
        transactionHash: prepared.transactionHash,
      };
      await persistence.persistPreparedTransaction(
        actor,
        context,
        batchId,
        claimed.reservationId,
        claimed.claimToken,
        metadata,
      );
      await client.broadcastPrepared(prepared);
      return "broadcastedUnknown";
    },
  };
}
