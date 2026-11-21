-- Automatic invoice predictions (MLOPS-06). Additive and idempotent: only a new
-- enum and table, no change to existing data. Rolling the application back is
-- safe: the older release ignores the table. Jobs left PENDING simply wait for
-- the next release that runs the worker.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "PredictionStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'SKIPPED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "InvoicePrediction" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "registeredModel" VARCHAR(256) NOT NULL,
    "modelVersion" VARCHAR(20) NOT NULL,
    "runId" VARCHAR(64),
    "featureSchemaVersion" VARCHAR(64),
    "probability" DOUBLE PRECISION,
    "status" "PredictionStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" VARCHAR(64),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoicePrediction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "InvoicePrediction_invoiceId_deploymentId_key" ON "InvoicePrediction"("invoiceId", "deploymentId");
CREATE INDEX IF NOT EXISTS "InvoicePrediction_status_nextAttemptAt_idx" ON "InvoicePrediction"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "InvoicePrediction_deploymentId_idx" ON "InvoicePrediction"("deploymentId");

-- AddForeignKey and CHECK (guarded so a repeat applies without error). The
-- composite keys tie the row to the same organization and scope as both the
-- invoice and the deployment.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InvoicePrediction_invoiceId_organizationId_scopeKey_fkey') THEN
    ALTER TABLE "InvoicePrediction" ADD CONSTRAINT "InvoicePrediction_invoiceId_organizationId_scopeKey_fkey" FOREIGN KEY ("invoiceId", "organizationId", "scopeKey") REFERENCES "Invoice"("id", "organizationId", "scopeKey") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InvoicePrediction_deploymentId_organizationId_scopeKey_fkey') THEN
    ALTER TABLE "InvoicePrediction" ADD CONSTRAINT "InvoicePrediction_deploymentId_organizationId_scopeKey_fkey" FOREIGN KEY ("deploymentId", "organizationId", "scopeKey") REFERENCES "Deployment"("id", "organizationId", "scopeKey") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InvoicePrediction_probability_range_check') THEN
    ALTER TABLE "InvoicePrediction" ADD CONSTRAINT "InvoicePrediction_probability_range_check" CHECK ("probability" IS NULL OR ("probability" >= 0 AND "probability" <= 1));
  END IF;
END
$$;
