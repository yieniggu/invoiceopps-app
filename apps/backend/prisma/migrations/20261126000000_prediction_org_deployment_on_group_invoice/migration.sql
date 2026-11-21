-- A group invoice is also scored by its organization's deployments, so a
-- prediction's scopeKey is now the INVOICE's scope (the invoice composite FK
-- keeps enforcing it) and no longer has to equal the deployment's scope. The
-- deployment keeps a plain FK; enqueue only picks deployments of the same
-- organization whose scope is the invoice's or the organization's.
ALTER TABLE "InvoicePrediction" DROP CONSTRAINT IF EXISTS "InvoicePrediction_deploymentId_organizationId_scopeKey_fkey";
ALTER TABLE "InvoicePrediction" ADD CONSTRAINT "InvoicePrediction_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
