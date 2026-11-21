import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { ORGANIZATION_SCOPE_KEY } from "../models/authorization.js";

/** A deployment that may score an invoice created now. */
export interface EligibleDeployment {
  id: string;
  organizationId: string;
  registeredModel: string;
  version: string;
  runId: string | null;
}

/**
 * Deployments eligible to score an invoice of `scope` (MLOPS-06): ACTIVE with
 * inference on, in the invoice's own scope (same organization and scopeKey) or
 * at the organization level (scopeKey "organization") of the same
 * organization, and only while the organization's mlEnabled is on. A group
 * invoice is scored by its group's deployments AND the organization's, an
 * organization-level invoice only by organization deployments, and a group
 * deployment never scores another group's or organization-level invoices.
 *
 * This is a short read of its own, run BEFORE the invoice transaction: inside
 * a SERIALIZABLE transaction a scan of Deployment and Organization would take
 * predicate locks that conflict with every concurrent deployment or ML switch
 * change and abort unrelated invoice creates (RETRYABLE_CONFLICT). The answer
 * may be stale by the time the invoice commits; that is safe because the
 * worker re-checks mlEnabled and the deployment at processing time, and the
 * database refuses a row that links a deployment of another organization or
 * scope (composite key and scope trigger).
 */
export async function findEligibleDeployments(
  prisma: Pick<PrismaClient, "deployment">,
  scope: { organizationId: string; scopeKey: string },
): Promise<EligibleDeployment[]> {
  return prisma.deployment.findMany({
    where: {
      organizationId: scope.organizationId,
      scopeKey: { in: [scope.scopeKey, ORGANIZATION_SCOPE_KEY] },
      status: "ACTIVE",
      inferenceEnabled: true,
      organization: { mlEnabled: true },
    },
    select: {
      id: true,
      organizationId: true,
      registeredModel: true,
      version: true,
      runId: true,
    },
    orderBy: { id: "asc" },
  });
}

/**
 * Outbox insert (MLOPS-06). Runs in the SAME transaction that creates the
 * invoice: one PENDING InvoicePrediction per eligible deployment (see
 * findEligibleDeployments, read before the transaction). The prediction row's
 * scopeKey is the invoice's. Only INSERTs: no scan of other tables, so the
 * transaction takes no extra predicate locks. With no eligible deployment it
 * inserts nothing. The Model API is never called here.
 *
 * Invoices created before a deployment was activated are never scored (no
 * retroactive jobs): only the deployments eligible at creation get a job.
 */
export async function enqueueInvoicePredictions(
  transaction: Prisma.TransactionClient,
  invoice: { id: string; organizationId: string; scopeKey: string },
  deployments: readonly EligibleDeployment[],
): Promise<number> {
  if (deployments.length === 0) return 0;
  const { count } = await transaction.invoicePrediction.createMany({
    data: deployments.map((deployment) => ({
      invoiceId: invoice.id,
      deploymentId: deployment.id,
      organizationId: invoice.organizationId,
      scopeKey: invoice.scopeKey,
      registeredModel: deployment.registeredModel,
      modelVersion: deployment.version,
      runId: deployment.runId,
    })),
    skipDuplicates: true,
  });
  return count;
}

/** A deleted invoice is never scored: its waiting jobs are skipped. */
export async function skipPendingPredictions(
  transaction: Prisma.TransactionClient,
  invoiceId: string,
): Promise<void> {
  await transaction.invoicePrediction.updateMany({
    where: { invoiceId, status: "PENDING" },
    data: { status: "SKIPPED", lastErrorCode: "INVOICE_DELETED" },
  });
}
