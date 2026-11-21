-- Indexes for the periodic prediction queue gauge (CR-516). Every statement is
-- guarded, so applying this file a second time changes nothing and fails on
-- nothing. Prisma itself applies it once and records it.
--
-- (status, createdAt): PENDING count and oldest PENDING createdAt without
-- reading SUCCEEDED or SKIPPED rows.
-- (status, updatedAt): FAILED jobs of the recent window as an index range.
--
-- A plain CREATE INDEX blocks writes to "InvoicePrediction" while it builds
-- (Prisma runs a migration in one transaction, so CONCURRENTLY is not
-- available). Reads continue. Apply it in a low-traffic window if the table
-- already holds millions of rows.
CREATE INDEX IF NOT EXISTS "InvoicePrediction_status_createdAt_idx"
  ON "InvoicePrediction" ("status", "createdAt");

CREATE INDEX IF NOT EXISTS "InvoicePrediction_status_updatedAt_idx"
  ON "InvoicePrediction" ("status", "updatedAt");
