-- User status and activity (B3c). Idempotent: a database that already has
-- these objects (for example one created from the previous edit of the
-- baseline migration) applies it without error.

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "disabledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastActiveAt" TIMESTAMP(3);

-- AlterEnum
ALTER TYPE "PlatformAdministrativeAuditEventType" ADD VALUE IF NOT EXISTS 'USER_DEACTIVATED';
ALTER TYPE "PlatformAdministrativeAuditEventType" ADD VALUE IF NOT EXISTS 'USER_REACTIVATED';
ALTER TYPE "PlatformAdministrativeAuditEventType" ADD VALUE IF NOT EXISTS 'USER_UPDATED';
ALTER TYPE "PlatformAdministrativeAuditEventType" ADD VALUE IF NOT EXISTS 'PASSWORD_RESET';
ALTER TYPE "PlatformAdministrativeAuditEventType" ADD VALUE IF NOT EXISTS 'ORGANIZATION_UPDATED';

-- Trigram indexes for the substring (ILIKE '%term%') searches of the admin
-- user directory (User.name, User.rut) and the organization list
-- (Organization.name).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_name_trgm_idx" ON "User" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_rut_trgm_idx" ON "User" USING GIN ("rut" gin_trgm_ops);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Organization_name_trgm_idx" ON "Organization" USING GIN ("name" gin_trgm_ops);

-- Contact data of the profile is unique among users (NULLs never collide):
-- PATCH /profile answers 409 USER_CONFLICT on a duplicate email or username.
-- It stores the email trimmed and lower-cased and the username trimmed (blank
-- becomes NULL): bring the existing rows to that form first, so the unique
-- indexes compare what the application compares. Re-running changes nothing.
UPDATE "User" SET "email" = NULLIF(lower(btrim("email")), '') WHERE "email" IS NOT NULL AND "email" IS DISTINCT FROM NULLIF(lower(btrim("email")), '');
UPDATE "User" SET "username" = NULLIF(btrim("username"), '') WHERE "username" IS NOT NULL AND "username" IS DISTINCT FROM NULLIF(btrim("username"), '');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "User" WHERE "email" IS NOT NULL GROUP BY "email" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Cannot create unique index "User_email_key": several users share the same email once trimmed and lower-cased. Resolve the duplicate emails before applying this migration.';
  END IF;
  IF EXISTS (SELECT 1 FROM "User" WHERE "username" IS NOT NULL GROUP BY "username" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Cannot create unique index "User_username_key": several users share the same username once trimmed. Resolve the duplicate usernames before applying this migration.';
  END IF;
END
$$;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
