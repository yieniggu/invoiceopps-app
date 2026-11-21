-- Prediction integrity, retry bookkeeping and the ML switch audit (MLOPS-06
-- review batch). Every statement is guarded, so applying this file a second
-- time (for example by hand after a partial run) changes nothing and fails
-- on nothing. Prisma itself applies it once and records it. Migrations that
-- were already applied (20261126000000 included) are NOT re-runnable and are
-- never edited: this file corrects them forward.
--
-- Rolling the application back is safe: the older release ignores the new
-- columns, and the integrity guards only reject rows an older release could
-- not legitimately write (it enqueues same-organization deployments only).

-- 1. A prediction's deployment must belong to the SAME organization as the
--    prediction (and therefore as its invoice, which the invoice composite key
--    already ties to the same organization). 20261126000000 replaced the
--    composite key by a plain deploymentId key, which let a row link an
--    organization A invoice to an organization B deployment.
CREATE UNIQUE INDEX IF NOT EXISTS "Deployment_id_organizationId_key"
  ON "Deployment" ("id", "organizationId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'InvoicePrediction_deploymentId_organizationId_fkey'
      AND conrelid = '"InvoicePrediction"'::regclass
  ) THEN
    -- NOT VALID first: the key is enforced for new rows at once while the
    -- existing rows are checked by VALIDATE below, which does not block
    -- concurrent writes for the duration of the scan.
    ALTER TABLE "InvoicePrediction"
      ADD CONSTRAINT "InvoicePrediction_deploymentId_organizationId_fkey"
      FOREIGN KEY ("deploymentId", "organizationId")
      REFERENCES "Deployment" ("id", "organizationId")
      ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END
$$;

-- A no-op when the constraint is already validated.
ALTER TABLE "InvoicePrediction"
  VALIDATE CONSTRAINT "InvoicePrediction_deploymentId_organizationId_fkey";

ALTER TABLE "InvoicePrediction"
  DROP CONSTRAINT IF EXISTS "InvoicePrediction_deploymentId_fkey";

-- 2. A deployment scores an invoice only from the invoice's own scope or from
--    the organization level: deployment.scopeKey = prediction.scopeKey (the
--    INVOICE's scope) or 'organization'. A group deployment can therefore
--    never score another group's invoice. A missing deployment is left to the
--    foreign key, which reports it.
CREATE OR REPLACE FUNCTION invoice_prediction_scope_guard() RETURNS trigger AS $$
DECLARE
  deployment_scope text;
BEGIN
  SELECT "scopeKey" INTO deployment_scope
  FROM "Deployment"
  WHERE "id" = NEW."deploymentId" AND "organizationId" = NEW."organizationId";
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF deployment_scope <> NEW."scopeKey" AND deployment_scope <> 'organization' THEN
    RAISE EXCEPTION 'InvoicePrediction scope % cannot use a deployment of scope %',
      NEW."scopeKey", deployment_scope
      USING ERRCODE = '23514', CONSTRAINT = 'InvoicePrediction_deployment_scope_check';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "InvoicePrediction_deployment_scope_guard" ON "InvoicePrediction";
CREATE TRIGGER "InvoicePrediction_deployment_scope_guard"
BEFORE INSERT OR UPDATE OF "deploymentId", "organizationId", "scopeKey" ON "InvoicePrediction"
FOR EACH ROW EXECUTE FUNCTION invoice_prediction_scope_guard();

-- 3. The (id, organizationId, scopeKey) unique key of Deployment only served
--    the composite key that 20261126000000 dropped; nothing references it.
DROP INDEX IF EXISTS "Deployment_id_organizationId_scopeKey_key";

-- 4. Retries caused by an unavailable Model API do not consume an attempt;
--    this counter drives their capped backoff instead (adds a column with a
--    constant default: no table rewrite).
ALTER TABLE "InvoicePrediction"
  ADD COLUMN IF NOT EXISTS "unavailableRetries" INTEGER NOT NULL DEFAULT 0;

-- 5. Invoices without a supplier key (rows written by an older release during
--    a rolling deploy, or not backfilled yet) are looked up by the worker on
--    every prediction and by the backfill. The index only holds those rows, so
--    it stays tiny once the backfill ran. A plain CREATE INDEX holds a write
--    lock on "Invoice" while it builds (Prisma runs a migration in one
--    transaction, so CONCURRENTLY is not available); with few NULL keys that
--    is a short pause.
CREATE INDEX IF NOT EXISTS "Invoice_supplierKey_null_idx"
  ON "Invoice" ("organizationId", "scopeKey", "createdAt" DESC)
  WHERE "supplierKey" IS NULL;

-- 6. Durable audit of the ML switch: the old and new value of mlEnabled travel
--    with the ORGANIZATION_UPDATED event (null for every other event).
ALTER TABLE "PlatformAdministrativeAuditEvent"
  ADD COLUMN IF NOT EXISTS "mlEnabledFrom" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "mlEnabledTo" BOOLEAN;
