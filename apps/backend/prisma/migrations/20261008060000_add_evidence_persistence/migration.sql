CREATE TABLE "EvidenceRecord" (
    "id" TEXT NOT NULL,
    "decisionEventId" TEXT NOT NULL,
    "evidenceVersion" TEXT NOT NULL,
    "canonicalVersion" TEXT NOT NULL,
    "invoiceRecordId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerType" "ResourceOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "canonicalPayload" BYTEA NOT NULL,
    "leafHash" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvidenceRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EvidenceRecord_evidenceVersion_check" CHECK ("evidenceVersion" = 'invoice-evidence-v2'),
    CONSTRAINT "EvidenceRecord_canonicalVersion_check" CHECK ("canonicalVersion" = 'invoice-evidence-canonical-v2'),
    CONSTRAINT "EvidenceRecord_canonicalPayload_size_check" CHECK (octet_length("canonicalPayload") BETWEEN 1 AND 16384),
    CONSTRAINT "EvidenceRecord_leafHash_size_check" CHECK (octet_length("leafHash") = 32)
);

CREATE TABLE "EvidenceBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerType" "ResourceOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "rootHash" BYTEA NOT NULL,
    "leafCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvidenceBatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EvidenceBatch_policyVersion_check" CHECK ("policyVersion" = 'invoice-merkle-v2'),
    CONSTRAINT "EvidenceBatch_rootHash_size_check" CHECK (octet_length("rootHash") = 32),
    CONSTRAINT "EvidenceBatch_leafCount_range_check" CHECK ("leafCount" BETWEEN 1 AND 256)
);

CREATE TABLE "EvidenceBatchItem" (
    "batchId" TEXT NOT NULL,
    "evidenceRecordId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerType" "ResourceOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "leafIndex" INTEGER NOT NULL,
    CONSTRAINT "EvidenceBatchItem_pkey" PRIMARY KEY ("batchId", "leafIndex"),
    CONSTRAINT "EvidenceBatchItem_leafIndex_range_check" CHECK ("leafIndex" BETWEEN 0 AND 255)
);

CREATE UNIQUE INDEX "EvidenceRecord_decisionEventId_evidenceVersion_key" ON "EvidenceRecord"("decisionEventId", "evidenceVersion");
CREATE UNIQUE INDEX "EvidenceRecord_id_organizationId_ownerType_ownerId_key" ON "EvidenceRecord"("id", "organizationId", "ownerType", "ownerId");
CREATE INDEX "EvidenceRecord_organizationId_ownerType_ownerId_decisionEventId_idx" ON "EvidenceRecord"("organizationId", "ownerType", "ownerId", "decisionEventId");
CREATE UNIQUE INDEX "EvidenceBatch_id_organizationId_ownerType_ownerId_key" ON "EvidenceBatch"("id", "organizationId", "ownerType", "ownerId");
CREATE UNIQUE INDEX "EvidenceBatch_organizationId_ownerType_ownerId_policyVersion_rootHash_key" ON "EvidenceBatch"("organizationId", "ownerType", "ownerId", "policyVersion", "rootHash");
CREATE INDEX "EvidenceBatch_organizationId_ownerType_ownerId_createdAt_id_idx" ON "EvidenceBatch"("organizationId", "ownerType", "ownerId", "createdAt", "id");
CREATE UNIQUE INDEX "EvidenceBatchItem_batchId_evidenceRecordId_key" ON "EvidenceBatchItem"("batchId", "evidenceRecordId");
CREATE INDEX "EvidenceBatchItem_evidenceRecordId_organizationId_ownerType_ownerId_idx" ON "EvidenceBatchItem"("evidenceRecordId", "organizationId", "ownerType", "ownerId");

ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_decisionEventId_fkey" FOREIGN KEY ("decisionEventId") REFERENCES "DecisionEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvidenceBatchItem" ADD CONSTRAINT "EvidenceBatchItem_batch_owner_fkey" FOREIGN KEY ("batchId", "organizationId", "ownerType", "ownerId") REFERENCES "EvidenceBatch"("id", "organizationId", "ownerType", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvidenceBatchItem" ADD CONSTRAINT "EvidenceBatchItem_record_owner_fkey" FOREIGN KEY ("evidenceRecordId", "organizationId", "ownerType", "ownerId") REFERENCES "EvidenceRecord"("id", "organizationId", "ownerType", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Serialize Evidence inserts with non-key DecisionEvent UPDATE/DELETE before
-- the FK takes its weaker key-share lock. A first insert creates a parent row
-- version, so older repeatable-read/serializable writers cannot commit unseen.
CREATE FUNCTION serialize_evidence_decision_insert() RETURNS trigger AS $$
BEGIN
    PERFORM 1 FROM "DecisionEvent" WHERE "id" = NEW."decisionEventId" FOR NO KEY UPDATE;
    IF FOUND AND NOT EXISTS (
        SELECT 1 FROM "EvidenceRecord" WHERE "decisionEventId" = NEW."decisionEventId"
    ) THEN
        UPDATE "DecisionEvent"
        SET "ruleVersion" = "ruleVersion"
        WHERE "id" = NEW."decisionEventId";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER serialize_evidence_decision_insert
BEFORE INSERT ON "EvidenceRecord"
FOR EACH ROW EXECUTE FUNCTION serialize_evidence_decision_insert();

CREATE FUNCTION prevent_evidence_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Evidence is append-only';
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_evidence_record_mutation
BEFORE UPDATE OR DELETE ON "EvidenceRecord"
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER prevent_evidence_batch_mutation
BEFORE UPDATE OR DELETE ON "EvidenceBatch"
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE TRIGGER prevent_evidence_batch_item_mutation
BEFORE UPDATE OR DELETE ON "EvidenceBatchItem"
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();

CREATE FUNCTION prevent_evidenced_decision_mutation() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "EvidenceRecord" WHERE "decisionEventId" = OLD."id") THEN
        RAISE EXCEPTION 'DecisionEvent with Evidence is append-only';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_evidenced_decision_mutation
BEFORE UPDATE OR DELETE ON "DecisionEvent"
FOR EACH ROW EXECUTE FUNCTION prevent_evidenced_decision_mutation();
