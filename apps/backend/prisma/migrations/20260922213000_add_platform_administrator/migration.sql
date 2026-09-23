CREATE TYPE "PlatformAdministrativeAuditEventType" AS ENUM (
    'PLATFORM_ADMINISTRATOR_BOOTSTRAPPED',
    'PLATFORM_ADMINISTRATOR_TRANSFERRED',
    'ORGANIZATION_MEMBERSHIP_CREATED',
    'ORGANIZATION_MEMBERSHIP_ROLE_CHANGED',
    'ORGANIZATION_MEMBERSHIP_REMOVED'
);

CREATE TABLE "PlatformAdministrator" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformAdministrator_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PlatformAdministrator_singleton_check" CHECK ("id" = 1)
);

CREATE TABLE "PlatformAdministrativeAuditEvent" (
    "id" TEXT NOT NULL,
    "type" "PlatformAdministrativeAuditEventType" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "organizationId" TEXT,
    "previousRole" "OrganizationRole",
    "role" "OrganizationRole",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformAdministrativeAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformAdministrator_userId_key" ON "PlatformAdministrator"("userId");
CREATE INDEX "PlatformAdministrativeAuditEvent_organizationId_createdAt_id_idx" ON "PlatformAdministrativeAuditEvent"("organizationId", "createdAt", "id");
CREATE INDEX "PlatformAdministrativeAuditEvent_targetUserId_createdAt_id_idx" ON "PlatformAdministrativeAuditEvent"("targetUserId", "createdAt", "id");

ALTER TABLE "PlatformAdministrator" ADD CONSTRAINT "PlatformAdministrator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlatformAdministrativeAuditEvent" ADD CONSTRAINT "PlatformAdministrativeAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlatformAdministrativeAuditEvent" ADD CONSTRAINT "PlatformAdministrativeAuditEvent_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION prevent_platform_administrator_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'PlatformAdministrator cannot be deleted';
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_platform_administrator_delete
BEFORE DELETE ON "PlatformAdministrator"
FOR EACH ROW EXECUTE FUNCTION prevent_platform_administrator_delete();

CREATE FUNCTION prevent_platform_administrative_audit_event_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'PlatformAdministrativeAuditEvent is append-only';
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_platform_administrative_audit_event_mutation
BEFORE UPDATE OR DELETE ON "PlatformAdministrativeAuditEvent"
FOR EACH ROW EXECUTE FUNCTION prevent_platform_administrative_audit_event_mutation();
