import type { Prisma } from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import { hasMlflowAccess } from "../api-tokens/mlflow-access.js";
import { loadEffectivePermissions } from "../groups/invoice-permissions.js";
import { lockMembershipsForInvoiceWrite } from "../groups/locks.js";
import type { ModelsContext } from "./types.js";

/** scopeKey of a deployment outside any group (mirrors the database CHECK). */
export const ORGANIZATION_SCOPE_KEY = "organization";

export function scopeKeyOf(context: ModelsContext) {
  return context.groupId ?? ORGANIZATION_SCOPE_KEY;
}

/** MLflow workspace of a context; built here, never taken from client input. */
export function workspaceOf(context: ModelsContext) {
  return context.groupId === null
    ? `org-${context.organizationId}`
    : `grp-${context.groupId}`;
}

export function notFound() {
  return new ApiError(404, "NOT_FOUND", "Not found");
}

/**
 * Authorizes one models operation inside the caller's transaction. Checks, in
 * this order, so nothing about another context leaks:
 *
 * 1. 404 for a non-member or a nonexistent organization (the platform
 *    administrator has no implicit membership), 404 for a group of another
 *    organization, 404 while the organization's `mlEnabled` flag is off: the
 *    feature simply does not exist for them;
 * 2. 403 unless the actor is an active member of the context (the rule the
 *    MLflow gateway applies to the same workspace);
 * 3. for `deploy`, 403 unless the effective `deployModels` flag is set
 *    (organization flag OR group flag in a group; no role grants it).
 *
 * The memberships are locked FOR SHARE, so a concurrent permission change or
 * removal serializes with the operation.
 */
export async function authorizeModelsContext(
  transaction: Prisma.TransactionClient,
  userId: string,
  context: ModelsContext,
  need: "read" | "deploy",
) {
  const { organizationMembership } = await lockMembershipsForInvoiceWrite(
    transaction,
    {
      userId,
      organizationId: context.organizationId,
      groupId: context.groupId,
    },
  );
  if (!organizationMembership) throw notFound();
  const organization = await transaction.organization.findUnique({
    where: { id: context.organizationId },
    select: { mlEnabled: true },
  });
  if (!organization?.mlEnabled) throw notFound();
  if (context.groupId !== null) {
    const group = await transaction.group.findFirst({
      where: { id: context.groupId, organizationId: context.organizationId },
      select: { id: true },
    });
    if (!group) throw notFound();
  }
  const active = await hasMlflowAccess(transaction, {
    userId,
    organizationId: context.organizationId,
    groupId: context.groupId,
  });
  if (!active) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Models are not available to you here",
    );
  }
  if (need === "deploy") {
    const permissions = await loadEffectivePermissions(transaction, {
      userId,
      organizationId: context.organizationId,
      groupId: context.groupId,
    });
    if (!permissions.deployModels) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Deploying models in this scope is not allowed",
      );
    }
  }
}
