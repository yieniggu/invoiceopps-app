CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'AUTO_PROCESSED', 'MANUAL_REVIEW', 'CANCELLED');

CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerType" "ResourceOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "vendorName" TEXT NOT NULL,
    "invoiceAmountCents" INTEGER NOT NULL,
    "hasPurchaseOrder" BOOLEAN NOT NULL,
    "threeWayMatch" BOOLEAN NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "vendorTenureDays" INTEGER NOT NULL,
    "previousIncidents12m" INTEGER NOT NULL,
    "bankAccountRecentlyChanged" BOOLEAN NOT NULL,
    "amountVsVendorMedian" DOUBLE PRECISION NOT NULL,
    "countryRisk" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DecisionEvent" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "actorRut" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invoice_organizationId_invoiceId_key" ON "Invoice"("organizationId", "invoiceId");
CREATE INDEX "Invoice_organizationId_ownerType_ownerId_createdAt_id_idx" ON "Invoice"("organizationId", "ownerType", "ownerId", "createdAt", "id");
CREATE UNIQUE INDEX "DecisionEvent_correlationId_key" ON "DecisionEvent"("correlationId");
CREATE INDEX "DecisionEvent_invoiceId_createdAt_id_idx" ON "DecisionEvent"("invoiceId", "createdAt", "id");

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DecisionEvent" ADD CONSTRAINT "DecisionEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DecisionEvent" ADD CONSTRAINT "DecisionEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
