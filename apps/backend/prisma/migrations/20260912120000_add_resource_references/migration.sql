-- Generic references keep owner-scoped navigation metadata without copying MLflow artifacts.
CREATE TYPE "ResourceOwnerType" AS ENUM ('USER', 'GROUP');

CREATE TABLE "ResourceReference" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerType" "ResourceOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "ResourceReference_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ResourceReference_organizationId_ownerType_ownerId_idx"
ON "ResourceReference"("organizationId", "ownerType", "ownerId");

ALTER TABLE "ResourceReference"
ADD CONSTRAINT "ResourceReference_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ResourceReference"
ADD CONSTRAINT "ResourceReference_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
