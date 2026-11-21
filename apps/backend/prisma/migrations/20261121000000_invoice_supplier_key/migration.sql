-- Canonical supplier key for the automatic-prediction priors (MLOPS-06).
-- Additive and idempotent: one nullable column and one index, existing rows are
-- untouched. Rolling the application back is safe: the older release ignores
-- the column (rows it inserts keep a NULL key until the next backfill).
--
-- The key is `supplierKey(supplierName)` of src/supplier-key.ts (NFKC, lowercase,
-- explicit whitespace split), identical to invoiceops_ml.contract.supplier_key.
-- SQL cannot compute it, so the column stays NULLABLE and existing rows are
-- filled by the idempotent backfill that the backend runs at startup
-- (src/supplier-key-backfill.ts, also `pnpm --filter @invoiceops/backend
-- backfill:supplier-key`). Rows with a NULL key are simply not used as priors
-- until they are backfilled.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "supplierKey" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Invoice_organizationId_scopeKey_supplierKey_createdAt_idx"
  ON "Invoice" ("organizationId", "scopeKey", "supplierKey", "createdAt" DESC);
