CREATE TABLE "BusinessPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerType" "ResourceOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manualReviewThreshold" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BusinessPolicy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BusinessPolicy_manualReviewThreshold_range_check" CHECK ("manualReviewThreshold" >= 0 AND "manualReviewThreshold" <= 1)
);

ALTER TABLE "Invoice" ADD COLUMN "policyProbability" DECIMAL(65,30);
ALTER TABLE "Invoice" ADD COLUMN "policyProbabilitySource" TEXT;
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_policyProbability_range_check" CHECK ("policyProbability" IS NULL OR ("policyProbability" >= 0 AND "policyProbability" <= 1));
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_policyProbability_source_check" CHECK ("policyProbabilitySource" IS NULL OR "policyProbabilitySource" = 'LOCAL_DEMONSTRATION');
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_policyProbability_pair_check" CHECK (("policyProbability" IS NULL) = ("policyProbabilitySource" IS NULL));

ALTER TABLE "DecisionEvent" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'RULE_V1';
ALTER TABLE "DecisionEvent" ADD COLUMN "policyVersion" TEXT;
ALTER TABLE "DecisionEvent" ADD COLUMN "manualReviewThreshold" DECIMAL(65,30);
ALTER TABLE "DecisionEvent" ADD COLUMN "policyProbability" DECIMAL(65,30);
ALTER TABLE "DecisionEvent" ADD COLUMN "policyProbabilitySource" TEXT;
ALTER TABLE "DecisionEvent" ADD CONSTRAINT "DecisionEvent_policyProbability_range_check" CHECK ("policyProbability" IS NULL OR ("policyProbability" >= 0 AND "policyProbability" <= 1));
ALTER TABLE "DecisionEvent" ADD CONSTRAINT "DecisionEvent_policyProbability_source_check" CHECK ("policyProbabilitySource" IS NULL OR "policyProbabilitySource" = 'LOCAL_DEMONSTRATION');

CREATE UNIQUE INDEX "BusinessPolicy_organizationId_ownerType_ownerId_version_key" ON "BusinessPolicy"("organizationId", "ownerType", "ownerId", "version");
CREATE INDEX "BusinessPolicy_organizationId_ownerType_ownerId_idx" ON "BusinessPolicy"("organizationId", "ownerType", "ownerId");

ALTER TABLE "BusinessPolicy" ADD CONSTRAINT "BusinessPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
