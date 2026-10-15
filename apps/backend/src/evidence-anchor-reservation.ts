import { randomBytes, randomUUID } from "node:crypto";

import { AuthError, type AuthUser } from "./auth.js";
import type { EvidenceAnchorTarget } from "./evidence-anchor-client.js";
import { createEvidencePersistence } from "./evidence-persistence.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { authorizeContext, ownerType } from "./invoices.js";
import type { ResourceContext } from "./resources.js";
import { createEvidenceAnchorTransactions } from "./evidence-anchor-transactions.js";

export type AnchorClaimResult =
  | { kind: "acquired"; reservationId: string; claimToken: string }
  | { kind: "blocked" };

const ROOT = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function createEvidenceAnchorReservation(prisma: PrismaClient) {
  const evidence = createEvidencePersistence(prisma);
  return {
    ...createEvidenceAnchorTransactions(prisma),
    async claimAnchorSubmission(
      actor: AuthUser,
      context: ResourceContext,
      batchId: string,
      root: string,
      target: EvidenceAnchorTarget,
    ): Promise<AnchorClaimResult> {
      // The authorized reconstruction precedes every claim or collision check.
      const batch = await evidence.getBatch(actor, context, batchId);
      if (
        !ROOT.test(root) ||
        root.toLowerCase() !== batch.rootHash ||
        !Number.isSafeInteger(target.chainId) ||
        target.chainId <= 0 ||
        !ADDRESS.test(target.contractAddress)
      ) {
        throw new AuthError(400, "Invalid evidence anchor target or root");
      }
      const reservationId = randomUUID();
      const claimToken = randomBytes(32).toString("hex");
      return prisma.$transaction(async (tx) => {
        await authorizeContext(tx, actor.id, context);
        const rows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "EvidenceAnchorReservation"
            ("id", "claimToken", "chainId", "contractAddress", "rootHash",
             "batchId", "organizationId", "ownerType", "ownerId", "actorUserId")
          VALUES
            (${reservationId}, ${claimToken}, ${BigInt(target.chainId)},
             ${Buffer.from(target.contractAddress.slice(2), "hex")},
             ${Buffer.from(batch.rootHash.slice(2), "hex")}, ${batch.id},
             ${context.organizationId}, ${ownerType(context.ownerType)}::"ResourceOwnerType",
             ${context.ownerId}, ${actor.id})
          ON CONFLICT ("chainId", "contractAddress", "rootHash") DO NOTHING
          RETURNING "id"
        `;
        return rows.length === 1
          ? { kind: "acquired", reservationId, claimToken }
          : { kind: "blocked" };
      });
    },
  };
}
