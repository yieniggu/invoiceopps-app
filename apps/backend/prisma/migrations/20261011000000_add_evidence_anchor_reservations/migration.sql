CREATE TABLE "EvidenceAnchorReservation" (
    "id" TEXT NOT NULL,
    "claimToken" TEXT NOT NULL,
    "chainId" BIGINT NOT NULL,
    "contractAddress" BYTEA NOT NULL,
    "rootHash" BYTEA NOT NULL,
    "batchId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerType" "ResourceOwnerType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvidenceAnchorReservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EvidenceAnchorReservation_chainId_check" CHECK ("chainId" BETWEEN 1 AND 9007199254740991),
    CONSTRAINT "EvidenceAnchorReservation_contractAddress_check" CHECK (octet_length("contractAddress") = 20),
    CONSTRAINT "EvidenceAnchorReservation_rootHash_check" CHECK (octet_length("rootHash") = 32),
    CONSTRAINT "EvidenceAnchorReservation_state_check" CHECK ("state" = 'RESERVED')
);

CREATE UNIQUE INDEX "EvidenceAnchorReservation_claimToken_key" ON "EvidenceAnchorReservation"("claimToken");
CREATE UNIQUE INDEX "EvidenceAnchorReservation_target_key" ON "EvidenceAnchorReservation"("chainId", "contractAddress", "rootHash");
CREATE INDEX "EvidenceAnchorReservation_batchId_organizationId_ownerType_ownerId_idx" ON "EvidenceAnchorReservation"("batchId", "organizationId", "ownerType", "ownerId");
CREATE INDEX "EvidenceAnchorReservation_actorUserId_idx" ON "EvidenceAnchorReservation"("actorUserId");
ALTER TABLE "EvidenceAnchorReservation" ADD CONSTRAINT "EvidenceAnchorReservation_batch_fkey" FOREIGN KEY ("batchId", "organizationId", "ownerType", "ownerId") REFERENCES "EvidenceBatch"("id", "organizationId", "ownerType", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvidenceAnchorReservation" ADD CONSTRAINT "EvidenceAnchorReservation_actor_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER prevent_evidence_anchor_reservation_mutation
BEFORE UPDATE OR DELETE ON "EvidenceAnchorReservation"
FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
