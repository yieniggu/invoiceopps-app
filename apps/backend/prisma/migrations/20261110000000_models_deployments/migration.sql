-- Models section and deployments (MLOPS-05). Additive and idempotent: existing
-- tables only gain nullable or defaulted columns, so it applies over existing
-- data (every organization starts with ml_enabled off and every membership
-- with deployModels false). Rolling the application back is safe: the older
-- release ignores the new columns and tables.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "DeploymentStatus" AS ENUM ('CHECKING', 'ACTIVE', 'INACTIVE', 'FAILED', 'QUARANTINED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE "DeploymentEventType" AS ENUM ('DEPLOYED', 'DEPLOY_FAILED', 'ACTIVATED', 'DEACTIVATED', 'REMOVED', 'QUARANTINED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "mlEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OrganizationMembership" ADD COLUMN IF NOT EXISTS "deployModels" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GroupMembership" ADD COLUMN IF NOT EXISTS "deployModels" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PlatformAdministrativeAuditEvent" ADD COLUMN IF NOT EXISTS "deployModels" BOOLEAN;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Deployment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "workspace" TEXT NOT NULL,
    "registeredModel" VARCHAR(256) NOT NULL,
    "version" VARCHAR(20) NOT NULL,
    "runId" VARCHAR(64),
    "status" "DeploymentStatus" NOT NULL,
    "inferenceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "gateReport" JSONB,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeploymentEvent" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "type" "DeploymentEventType" NOT NULL,
    "actorUserId" TEXT,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Deployment_organizationId_scopeKey_status_createdAt_idx" ON "Deployment"("organizationId", "scopeKey", "status", "createdAt" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "Deployment_id_organizationId_scopeKey_key" ON "Deployment"("id", "organizationId", "scopeKey");
CREATE INDEX IF NOT EXISTS "DeploymentEvent_deploymentId_createdAt_id_idx" ON "DeploymentEvent"("deploymentId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "DeploymentEvent_organizationId_createdAt_id_idx" ON "DeploymentEvent"("organizationId", "createdAt", "id");

-- One live deployment per model version in a scope. Prisma cannot express the
-- partial index, so it is documented in schema.prisma.
CREATE UNIQUE INDEX IF NOT EXISTS "Deployment_live_model_version_key"
  ON "Deployment"("organizationId", "scopeKey", "registeredModel", "version")
  WHERE "status" IN ('CHECKING', 'ACTIVE', 'QUARANTINED');

-- AddForeignKey and CHECK (guarded so a repeat applies without error)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Deployment_organizationId_fkey') THEN
    ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Deployment_groupId_organizationId_fkey') THEN
    ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_groupId_organizationId_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "Group"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Deployment_createdByUserId_fkey') THEN
    ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Deployment_scopeKey_matches_groupId_check') THEN
    ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_scopeKey_matches_groupId_check" CHECK ("scopeKey" = COALESCE("groupId", 'organization'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeploymentEvent_deploymentId_fkey') THEN
    ALTER TABLE "DeploymentEvent" ADD CONSTRAINT "DeploymentEvent_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeploymentEvent_actorUserId_fkey') THEN
    ALTER TABLE "DeploymentEvent" ADD CONSTRAINT "DeploymentEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DeploymentEvent_organizationId_fkey') THEN
    ALTER TABLE "DeploymentEvent" ADD CONSTRAINT "DeploymentEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
