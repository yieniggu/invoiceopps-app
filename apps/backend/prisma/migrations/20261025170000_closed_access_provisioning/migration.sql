ALTER TYPE "PlatformAdministrativeAuditEventType" ADD VALUE 'ORGANIZATION_CREATED';
ALTER TYPE "PlatformAdministrativeAuditEventType" ADD VALUE 'USER_PROVISIONED';
ALTER TYPE "PlatformAdministrativeAuditEventType" ADD VALUE 'PASSWORD_CHANGED';

ALTER TABLE "User"
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "temporaryPasswordExpiresAt" TIMESTAMP(3);
