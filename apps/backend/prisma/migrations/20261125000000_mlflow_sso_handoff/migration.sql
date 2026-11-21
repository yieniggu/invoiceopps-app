-- MLflow SSO handoff (redirect-based, host-only cookies). Additive and
-- idempotent: two new tables and nothing else is touched. Rolling the
-- application back is safe: the older release ignores the tables.

-- CreateTable
CREATE TABLE IF NOT EXISTS "MlflowHandoffCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlflowHandoffCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MlflowSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MlflowSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MlflowHandoffCode_codeHash_key" ON "MlflowHandoffCode"("codeHash");
CREATE INDEX IF NOT EXISTS "MlflowHandoffCode_sessionId_idx" ON "MlflowHandoffCode"("sessionId");
CREATE INDEX IF NOT EXISTS "MlflowHandoffCode_expiresAt_idx" ON "MlflowHandoffCode"("expiresAt");
CREATE UNIQUE INDEX IF NOT EXISTS "MlflowSession_tokenHash_key" ON "MlflowSession"("tokenHash");
CREATE INDEX IF NOT EXISTS "MlflowSession_sessionId_idx" ON "MlflowSession"("sessionId");
CREATE INDEX IF NOT EXISTS "MlflowSession_expiresAt_idx" ON "MlflowSession"("expiresAt");

-- AddForeignKey (guarded so a repeat applies without error)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MlflowHandoffCode_userId_fkey') THEN
    ALTER TABLE "MlflowHandoffCode" ADD CONSTRAINT "MlflowHandoffCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MlflowHandoffCode_sessionId_fkey') THEN
    ALTER TABLE "MlflowHandoffCode" ADD CONSTRAINT "MlflowHandoffCode_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MlflowSession_userId_fkey') THEN
    ALTER TABLE "MlflowSession" ADD CONSTRAINT "MlflowSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MlflowSession_sessionId_fkey') THEN
    ALTER TABLE "MlflowSession" ADD CONSTRAINT "MlflowSession_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
