-- AlterTable
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;

-- CreateTable
CREATE TABLE "AuthorizedUserOrganization" (
    "id" TEXT NOT NULL,
    "rut" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "AuthorizedUserOrganization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizedUserOrganization_rut_organizationId_key" ON "AuthorizedUserOrganization"("rut", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- AddForeignKey
ALTER TABLE "AuthorizedUserOrganization" ADD CONSTRAINT "AuthorizedUserOrganization_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
