-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OrganizationRole" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "ResourceOwnerType" AS ENUM ('USER', 'GROUP');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('CLP');

-- CreateEnum
CREATE TYPE "InvoiceBusinessStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceProcessingStatus" AS ENUM ('NOT_REQUESTED');

-- CreateEnum
CREATE TYPE "ApiTokenScope" AS ENUM ('invoices:read', 'invoices:create', 'invoices:delete-own', 'invoices:delete-others');

-- CreateEnum
CREATE TYPE "PlatformAdministrativeAuditEventType" AS ENUM ('PLATFORM_ADMINISTRATOR_BOOTSTRAPPED', 'PLATFORM_ADMINISTRATOR_TRANSFERRED', 'ORGANIZATION_MEMBERSHIP_CREATED', 'ORGANIZATION_MEMBERSHIP_ROLE_CHANGED', 'ORGANIZATION_MEMBERSHIP_REMOVED', 'ORGANIZATION_CREATED', 'USER_PROVISIONED', 'PASSWORD_CHANGED', 'GROUP_MEMBERSHIP_CREATED', 'GROUP_MEMBERSHIP_REMOVED', 'MEMBERSHIP_PERMISSIONS_CHANGED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rut" TEXT NOT NULL,
    "email" TEXT,
    "username" TEXT,
    "passwordHash" TEXT,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "temporaryPasswordExpiresAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL,
    "readInvoices" BOOLEAN NOT NULL DEFAULT false,
    "createInvoices" BOOLEAN NOT NULL DEFAULT false,
    "deleteOwnInvoices" BOOLEAN NOT NULL DEFAULT false,
    "deleteOthersInvoices" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMembership" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "readInvoices" BOOLEAN NOT NULL DEFAULT false,
    "createInvoices" BOOLEAN NOT NULL DEFAULT false,
    "deleteOwnInvoices" BOOLEAN NOT NULL DEFAULT false,
    "deleteOthersInvoices" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "GroupMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "businessId" VARCHAR(80) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "supplierName" VARCHAR(200) NOT NULL,
    "amountPesos" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL,
    "issuedOn" DATE NOT NULL,
    "dueOn" DATE NOT NULL,
    "businessStatus" "InvoiceBusinessStatus" NOT NULL,
    "processingStatus" "InvoiceProcessingStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceIdempotencyRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "fingerprintVersion" INTEGER NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "responseSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceIdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "scopes" "ApiTokenScope"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerType" "ResourceOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manualReviewThreshold" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAdministrator" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAdministrator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAdministrativeAuditEvent" (
    "id" TEXT NOT NULL,
    "type" "PlatformAdministrativeAuditEventType" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "organizationId" TEXT,
    "groupId" TEXT,
    "previousRole" "OrganizationRole",
    "role" "OrganizationRole",
    "readInvoices" BOOLEAN,
    "createInvoices" BOOLEAN,
    "deleteOwnInvoices" BOOLEAN,
    "deleteOthersInvoices" BOOLEAN,
    "actorIsTarget" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAdministrativeAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_rut_key" ON "User"("rut");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_userId_organizationId_key" ON "OrganizationMembership"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "OrganizationMembership_organizationId_role_idx" ON "OrganizationMembership"("organizationId", "role");

-- CreateIndex
CREATE INDEX "Group_organizationId_name_idx" ON "Group"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Group_id_organizationId_key" ON "Group"("id", "organizationId");

-- CreateIndex
CREATE INDEX "GroupMembership_userId_organizationId_idx" ON "GroupMembership"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMembership_groupId_userId_key" ON "GroupMembership"("groupId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_scopeKey_deletedAt_createdAt_id_idx" ON "Invoice"("organizationId", "scopeKey", "deletedAt", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_businessId_key" ON "Invoice"("organizationId", "businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_id_organizationId_scopeKey_key" ON "Invoice"("id", "organizationId", "scopeKey");

-- CreateIndex
CREATE INDEX "InvoiceIdempotencyRecord_invoiceId_idx" ON "InvoiceIdempotencyRecord"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceIdempotencyRecord_userId_organizationId_scopeKey_ope_key" ON "InvoiceIdempotencyRecord"("userId", "organizationId", "scopeKey", "operation", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiToken_userId_organizationId_groupId_idx" ON "ApiToken"("userId", "organizationId", "groupId");

-- CreateIndex
CREATE INDEX "BusinessPolicy_organizationId_ownerType_ownerId_idx" ON "BusinessPolicy"("organizationId", "ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessPolicy_organizationId_ownerType_ownerId_version_key" ON "BusinessPolicy"("organizationId", "ownerType", "ownerId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdministrator_userId_key" ON "PlatformAdministrator"("userId");

-- CreateIndex
CREATE INDEX "PlatformAdministrativeAuditEvent_organizationId_createdAt_i_idx" ON "PlatformAdministrativeAuditEvent"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "PlatformAdministrativeAuditEvent_targetUserId_createdAt_id_idx" ON "PlatformAdministrativeAuditEvent"("targetUserId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_groupId_organizationId_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "Group"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "OrganizationMembership"("userId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_groupId_organizationId_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "Group"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_deletedByUserId_fkey" FOREIGN KEY ("deletedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceIdempotencyRecord" ADD CONSTRAINT "InvoiceIdempotencyRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceIdempotencyRecord" ADD CONSTRAINT "InvoiceIdempotencyRecord_groupId_organizationId_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "Group"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceIdempotencyRecord" ADD CONSTRAINT "InvoiceIdempotencyRecord_invoiceId_organizationId_scopeKey_fkey" FOREIGN KEY ("invoiceId", "organizationId", "scopeKey") REFERENCES "Invoice"("id", "organizationId", "scopeKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_groupId_organizationId_fkey" FOREIGN KEY ("groupId", "organizationId") REFERENCES "Group"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessPolicy" ADD CONSTRAINT "BusinessPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAdministrator" ADD CONSTRAINT "PlatformAdministrator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAdministrativeAuditEvent" ADD CONSTRAINT "PlatformAdministrativeAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAdministrativeAuditEvent" ADD CONSTRAINT "PlatformAdministrativeAuditEvent_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written constraints and guards (not expressible in the Prisma schema).

-- scopeKey mirrors the optional group of a row so that a NULL group (organization
-- scope) still takes part in the composite foreign key and in the idempotency
-- unique key; the CHECK keeps it from drifting away from groupId.
ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_scopeKey_matches_groupId_check" CHECK ("scopeKey" = COALESCE("groupId", 'organization'));

ALTER TABLE "InvoiceIdempotencyRecord"
  ADD CONSTRAINT "InvoiceIdempotencyRecord_scopeKey_matches_groupId_check" CHECK ("scopeKey" = COALESCE("groupId", 'organization'));

ALTER TABLE "PlatformAdministrator" ADD CONSTRAINT "PlatformAdministrator_singleton_check" CHECK ("id" = 1);

ALTER TABLE "BusinessPolicy" ADD CONSTRAINT "BusinessPolicy_manualReviewThreshold_range_check" CHECK ("manualReviewThreshold" >= 0 AND "manualReviewThreshold" <= 1);

ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_amountPesos_range_check" CHECK ("amountPesos" BETWEEN 1 AND 2147483647),
  ADD CONSTRAINT "Invoice_dueOn_after_issuedOn_check" CHECK ("dueOn" >= "issuedOn"),
  ADD CONSTRAINT "Invoice_businessId_length_check" CHECK (char_length(btrim("businessId", E' \t\r\n\f\x0b')) BETWEEN 1 AND 80),
  ADD CONSTRAINT "Invoice_supplierName_length_check" CHECK (char_length(btrim("supplierName", E' \t\r\n\f\x0b')) BETWEEN 1 AND 200),
  ADD CONSTRAINT "Invoice_businessId_trimmed_check" CHECK ("businessId" = btrim("businessId", E' \t\r\n\f\x0b')),
  ADD CONSTRAINT "Invoice_supplierName_trimmed_check" CHECK ("supplierName" = btrim("supplierName", E' \t\r\n\f\x0b')),
  ADD CONSTRAINT "Invoice_deletion_pair_check" CHECK (("deletedAt" IS NULL) = ("deletedByUserId" IS NULL));

CREATE FUNCTION api_token_scopes_are_distinct(scopes "ApiTokenScope"[]) RETURNS boolean AS $$
    SELECT cardinality(scopes) = (SELECT count(DISTINCT scope) FROM unnest(scopes) AS scope);
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE "ApiToken"
  ADD CONSTRAINT "ApiToken_expiresAt_after_createdAt_check" CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "ApiToken_expiresAt_max_lifetime_check" CHECK ("expiresAt" <= "createdAt" + interval '30 days'),
  ADD CONSTRAINT "ApiToken_scopes_not_empty_check" CHECK (cardinality("scopes") >= 1),
  ADD CONSTRAINT "ApiToken_scopes_distinct_check" CHECK (api_token_scopes_are_distinct("scopes"));

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
