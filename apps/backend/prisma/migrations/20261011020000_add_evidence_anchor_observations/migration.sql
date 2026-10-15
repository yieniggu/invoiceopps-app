CREATE UNIQUE INDEX "EvidencePreparedAnchorTransaction_observation_key" ON "EvidencePreparedAnchorTransaction"("reservationId", "chainId", "signerAddress", "contractAddress", "rootHash", "transactionHash");

CREATE TABLE "EvidenceAnchorObservation" (
  "id" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "chainId" BIGINT NOT NULL,
  "signerAddress" BYTEA NOT NULL,
  "contractAddress" BYTEA NOT NULL,
  "rootHash" BYTEA NOT NULL,
  "transactionHash" BYTEA NOT NULL,
  "kind" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "blockNumber" BIGINT,
  "blockHash" BYTEA,
  "receiptStatus" TEXT,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvidenceAnchorObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EvidenceAnchorObservation_identity_check" CHECK (
    "chainId" BETWEEN 1 AND 9007199254740991 AND
    octet_length("signerAddress") = 20 AND octet_length("contractAddress") = 20 AND
    octet_length("rootHash") = 32 AND octet_length("transactionHash") = 32),
  CONSTRAINT "EvidenceAnchorObservation_kind_check" CHECK (
    ("kind", "reason") IN (( 'pending', 'transactionMissing'), ('pending', 'receiptMissing'),
      ('needsReview', 'missingAfterObservation'), ('needsReview', 'rpcUnavailable'),
      ('needsReview', 'identityMismatch'), ('needsReview', 'receiptMismatch'),
      ('needsReview', 'eventMismatch'), ('orphaned', 'canonicalMismatch'),
      ('observedRevert', 'reverted'), ('observedSuccess', 'matched'))),
  CONSTRAINT "EvidenceAnchorObservation_block_check" CHECK ((
    ("kind" IN ('observedRevert', 'observedSuccess') AND "blockNumber" BETWEEN 0 AND 9007199254740991
      AND octet_length("blockHash") = 32 AND
      "receiptStatus" = CASE WHEN "kind" = 'observedSuccess' THEN 'success' ELSE 'reverted' END)
    OR ("kind" NOT IN ('observedRevert', 'observedSuccess') AND
      "blockNumber" IS NULL AND "blockHash" IS NULL AND "receiptStatus" IS NULL)) IS TRUE)
);
CREATE INDEX "EvidenceAnchorObservation_recent_idx" ON "EvidenceAnchorObservation"("reservationId", "checkedAt" DESC, "id" DESC);
CREATE INDEX "EvidenceAnchorObservation_prior_signal_idx" ON "EvidenceAnchorObservation"("reservationId", "checkedAt" DESC, "id" DESC) WHERE "kind" IN ('observedSuccess', 'observedRevert', 'orphaned');
ALTER TABLE "EvidenceAnchorObservation" ADD CONSTRAINT "EvidenceAnchorObservation_prepared_fkey" FOREIGN KEY ("reservationId", "chainId", "signerAddress", "contractAddress", "rootHash", "transactionHash") REFERENCES "EvidencePreparedAnchorTransaction"("reservationId", "chainId", "signerAddress", "contractAddress", "rootHash", "transactionHash") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvidenceAnchorObservation" ADD CONSTRAINT "EvidenceAnchorObservation_actor_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER prevent_evidence_anchor_observation_mutation BEFORE UPDATE OR DELETE ON "EvidenceAnchorObservation" FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
