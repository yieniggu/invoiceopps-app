import type {
  InvoicePrediction,
  Prisma,
} from "../../generated/prisma/client.js";
import type { z } from "zod";

import { ORGANIZATION_SCOPE_KEY } from "../models/authorization.js";
import type { PredictionSchema } from "./schemas.js";

export type PredictionDto = z.infer<typeof PredictionSchema>;

function toDto(
  row: InvoicePrediction & { deployment: { scopeKey: string } },
): PredictionDto {
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    deploymentScope:
      row.deployment.scopeKey === ORGANIZATION_SCOPE_KEY
        ? "ORGANIZATION"
        : "GROUP",
    registeredModel: row.registeredModel,
    modelVersion: row.modelVersion,
    runId: row.runId,
    probability: row.probability,
    status: row.status,
    errorCode: row.lastErrorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Predictions of an invoice the caller is already authorized to read, or
 * `null` while the organization's Models section (mlEnabled) is off, so the
 * response carries no `predictions` at all.
 */
export async function readInvoicePredictions(
  transaction: Prisma.TransactionClient,
  invoice: { id: string; organizationId: string },
): Promise<PredictionDto[] | null> {
  const organization = await transaction.organization.findUnique({
    where: { id: invoice.organizationId },
    select: { mlEnabled: true },
  });
  if (!organization?.mlEnabled) return null;
  const rows = await transaction.invoicePrediction.findMany({
    where: { invoiceId: invoice.id },
    include: { deployment: { select: { scopeKey: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toDto);
}
