import type { Prisma } from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import { requirePlatformAdministrator } from "../orgs/authority.js";

export function notFound() {
  return new ApiError(404, "NOT_FOUND", "Not found");
}

export function selfActionForbidden() {
  return new ApiError(
    409,
    "SELF_ACTION_FORBIDDEN",
    "You cannot perform this action on your own account",
  );
}

/**
 * Authority check shared by the actions on another user, with no read of the
 * target: the platform administrator is re-checked and the actor may not
 * target themselves. Transactions call this, take the target's user lock and
 * only then read the target.
 */
export async function requireActionableActor(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
  targetUserId: string,
) {
  await requirePlatformAdministrator(transaction, actorUserId);
  if (actorUserId === targetUserId) throw selfActionForbidden();
}

/**
 * Cheap pre-check outside any lock (authority, self action, target exists);
 * it decides nothing the transaction relies on, which repeats the checks
 * under the target's user lock.
 */
export async function requireActionableTarget(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
  targetUserId: string,
) {
  await requireActionableActor(transaction, actorUserId, targetUserId);
  const target = await transaction.user.findUnique({
    where: { id: targetUserId },
    select: { id: true },
  });
  if (!target) throw notFound();
}
