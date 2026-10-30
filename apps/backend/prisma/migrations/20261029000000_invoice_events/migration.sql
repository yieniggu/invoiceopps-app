-- Invoice events (RP0-12). Idempotent: a database that already has these
-- objects applies it without error. The consolidated baseline is untouched.

-- CreateEnum
DO $$
BEGIN
  CREATE TYPE "InvoiceEventType" AS ENUM ('INVOICE_DELETED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "InvoiceEvent" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "type" "InvoiceEventType" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "InvoiceEvent_invoiceId_type_key" ON "InvoiceEvent"("invoiceId", "type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InvoiceEvent_organizationId_createdAt_id_idx" ON "InvoiceEvent"("organizationId", "createdAt", "id");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceEvent_invoiceId_fkey') THEN
    ALTER TABLE "InvoiceEvent" ADD CONSTRAINT "InvoiceEvent_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceEvent_actorUserId_fkey') THEN
    ALTER TABLE "InvoiceEvent" ADD CONSTRAINT "InvoiceEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'InvoiceEvent_organizationId_fkey') THEN
    ALTER TABLE "InvoiceEvent" ADD CONSTRAINT "InvoiceEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- Read indexes of the invoice list and search (CR-328). Idempotent.
-- pg_trgm is also created by 20261028000000_user_status_activity; repeating it
-- keeps this migration self-contained.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Organization-wide list, newest first, active rows only. A partial index:
-- Prisma cannot express the WHERE, so it is documented in schema.prisma.
CREATE INDEX IF NOT EXISTS "Invoice_organizationId_active_createdAt_id_idx" ON "Invoice"("organizationId", "createdAt" DESC, "id" DESC) WHERE "deletedAt" IS NULL;

-- Case-insensitive contains search of q on businessId and supplierName.
CREATE INDEX IF NOT EXISTS "Invoice_businessId_trgm_idx" ON "Invoice" USING GIN ("businessId" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Invoice_supplierName_trgm_idx" ON "Invoice" USING GIN ("supplierName" gin_trgm_ops);

-- Scope immutability (CR-336). The deletion service reads the invoice's group
-- before it locks the memberships of that group; that is only safe while
-- organizationId, groupId and scopeKey never change after the insert.
CREATE OR REPLACE FUNCTION prevent_invoice_scope_change() RETURNS trigger AS $$
BEGIN
    IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
        OR NEW."groupId" IS DISTINCT FROM OLD."groupId"
        OR NEW."scopeKey" IS DISTINCT FROM OLD."scopeKey" THEN
        RAISE EXCEPTION 'Invoice scope (organizationId, groupId, scopeKey) is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "Invoice_scope_immutable"
BEFORE UPDATE ON "Invoice"
FOR EACH ROW EXECUTE FUNCTION prevent_invoice_scope_change();
