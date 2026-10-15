CREATE UNIQUE INDEX "EvidenceAnchorReservation_identity_key" ON "EvidenceAnchorReservation"("id", "chainId", "contractAddress", "rootHash", "batchId", "organizationId", "ownerType", "ownerId", "actorUserId");

CREATE TABLE "EvidenceSignerPreparationSlot" (
  "chainId" BIGINT NOT NULL,
  "signerAddress" BYTEA NOT NULL,
  "reservationId" TEXT NOT NULL,
  "contractAddress" BYTEA NOT NULL,
  "rootHash" BYTEA NOT NULL,
  "batchId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "ownerType" "ResourceOwnerType" NOT NULL,
  "ownerId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvidenceSignerPreparationSlot_pkey" PRIMARY KEY ("chainId", "signerAddress"),
  CONSTRAINT "EvidenceSignerPreparationSlot_signer_check" CHECK (octet_length("signerAddress") = 20),
  CONSTRAINT "EvidenceSignerPreparationSlot_contract_check" CHECK (octet_length("contractAddress") = 20),
  CONSTRAINT "EvidenceSignerPreparationSlot_root_check" CHECK (octet_length("rootHash") = 32),
  CONSTRAINT "EvidenceSignerPreparationSlot_chain_check" CHECK ("chainId" BETWEEN 1 AND 9007199254740991)
);
CREATE UNIQUE INDEX "EvidenceSignerPreparationSlot_reservationId_key" ON "EvidenceSignerPreparationSlot"("reservationId");
CREATE UNIQUE INDEX "EvidenceSignerPreparationSlot_reservation_identity_key" ON "EvidenceSignerPreparationSlot"("reservationId", "chainId", "signerAddress");
CREATE UNIQUE INDEX "EvidenceSignerPreparationSlot_reservation_full_key" ON "EvidenceSignerPreparationSlot"("reservationId", "chainId", "contractAddress", "rootHash", "batchId", "organizationId", "ownerType", "ownerId", "actorUserId");
CREATE UNIQUE INDEX "EvidenceSignerPreparationSlot_prepared_identity_key" ON "EvidenceSignerPreparationSlot"("reservationId", "chainId", "signerAddress", "contractAddress", "rootHash");
ALTER TABLE "EvidenceSignerPreparationSlot" ADD CONSTRAINT "EvidenceSignerPreparationSlot_reservation_fkey" FOREIGN KEY ("reservationId", "chainId", "contractAddress", "rootHash", "batchId", "organizationId", "ownerType", "ownerId", "actorUserId") REFERENCES "EvidenceAnchorReservation"("id", "chainId", "contractAddress", "rootHash", "batchId", "organizationId", "ownerType", "ownerId", "actorUserId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "EvidencePreparedAnchorTransaction" (
  "reservationId" TEXT NOT NULL,
  "chainId" BIGINT NOT NULL,
  "signerAddress" BYTEA NOT NULL,
  "contractAddress" BYTEA NOT NULL,
  "rootHash" BYTEA NOT NULL,
  "nonce" BIGINT NOT NULL,
  "gas" BIGINT NOT NULL,
  "maxFeePerGas" BIGINT NOT NULL,
  "maxPriorityFeePerGas" BIGINT NOT NULL,
  "transactionHash" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvidencePreparedAnchorTransaction_pkey" PRIMARY KEY ("reservationId"),
  CONSTRAINT "EvidencePreparedAnchorTransaction_nonce_check" CHECK ("nonce" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "EvidencePreparedAnchorTransaction_gas_check" CHECK ("gas" BETWEEN 21000 AND 3000000),
  CONSTRAINT "EvidencePreparedAnchorTransaction_fee_check" CHECK ("maxFeePerGas" BETWEEN 1 AND 1000000000000 AND "maxPriorityFeePerGas" BETWEEN 0 AND "maxFeePerGas"),
  CONSTRAINT "EvidencePreparedAnchorTransaction_signer_check" CHECK (octet_length("signerAddress") = 20),
  CONSTRAINT "EvidencePreparedAnchorTransaction_contract_check" CHECK (octet_length("contractAddress") = 20),
  CONSTRAINT "EvidencePreparedAnchorTransaction_root_check" CHECK (octet_length("rootHash") = 32),
  CONSTRAINT "EvidencePreparedAnchorTransaction_hash_check" CHECK (octet_length("transactionHash") = 32)
);
CREATE UNIQUE INDEX "EvidencePreparedAnchorTransaction_nonce_key" ON "EvidencePreparedAnchorTransaction"("chainId", "signerAddress", "nonce");
CREATE UNIQUE INDEX "EvidencePreparedAnchorTransaction_slot_key" ON "EvidencePreparedAnchorTransaction"("reservationId", "chainId", "signerAddress");
CREATE UNIQUE INDEX "EvidencePreparedAnchorTransaction_full_key" ON "EvidencePreparedAnchorTransaction"("reservationId", "chainId", "signerAddress", "contractAddress", "rootHash");
CREATE UNIQUE INDEX "EvidencePreparedAnchorTransaction_hash_key" ON "EvidencePreparedAnchorTransaction"("chainId", "transactionHash");
ALTER TABLE "EvidencePreparedAnchorTransaction" ADD CONSTRAINT "EvidencePreparedAnchorTransaction_reservation_fkey" FOREIGN KEY ("reservationId") REFERENCES "EvidenceAnchorReservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EvidencePreparedAnchorTransaction" ADD CONSTRAINT "EvidencePreparedAnchorTransaction_slot_fkey" FOREIGN KEY ("reservationId", "chainId", "signerAddress", "contractAddress", "rootHash") REFERENCES "EvidenceSignerPreparationSlot"("reservationId", "chainId", "signerAddress", "contractAddress", "rootHash") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER prevent_evidence_signer_slot_mutation BEFORE UPDATE OR DELETE ON "EvidenceSignerPreparationSlot" FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
CREATE TRIGGER prevent_evidence_prepared_transaction_mutation BEFORE UPDATE OR DELETE ON "EvidencePreparedAnchorTransaction" FOR EACH ROW EXECUTE FUNCTION prevent_evidence_mutation();
