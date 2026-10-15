import { describe, expect, it, vi } from "vitest";

import { createEvidenceAnchorClient } from "../src/evidence-anchor-client.js";
import type { AnchorClaimResult } from "../src/evidence-anchor-reservation.js";
import { createEvidenceAnchor } from "../src/evidence-anchor.js";
import {
  durablePreparationPorts,
  fixtureSigner,
  signedAnchorTransport,
} from "./evidence-anchor-fixture.js";

const root = `0x${"ab".repeat(32)}`;
const contractAddress = `0x${"12".repeat(20)}`;
const signerAddress = fixtureSigner;
const actor = { id: "actor-1", name: "Actor", rut: "123456785" };
const context = {
  organizationId: "org-1",
  ownerType: "user" as const,
  ownerId: actor.id,
};
const batchId = "batch-1";

function fixture() {
  const getBatch = vi.fn(async () => ({
    id: batchId,
    rootHash: root,
    leafCount: 1,
    policyVersion: "invoice-merkle-v2",
  }));
  const claimAnchorSubmission = vi.fn(async (): Promise<AnchorClaimResult> => ({
    kind: "acquired",
    reservationId: "reservation-1",
    claimToken: "token-1",
  }));
  const transport = {
    getChainId: vi.fn(async () => 31337),
    getSignerAddress: vi.fn(async () => signerAddress),
    getContractSigner: vi.fn(async () => signerAddress),
    isRootRegistered: vi.fn(async () => false),
    ...signedAnchorTransport(root, contractAddress),
  };
  const client = createEvidenceAnchorClient(
    { chainId: 31337, contractAddress, signerAddress },
    transport,
  );
  const persistence = {
    getBatch,
    claimAnchorSubmission,
    ...durablePreparationPorts(),
  };
  return { persistence, transport, client };
}

describe("APP-11 reservation orchestration preimplementation evidence", () => {
  it("AC-DR01 binds the claim to the chain, contract, batch and verified root before send", async () => {
    const { persistence, client, transport } = fixture();

    await createEvidenceAnchor(persistence, client).anchorBatch(
      actor,
      context,
      batchId,
    );

    expect(persistence.claimAnchorSubmission).toHaveBeenCalledExactlyOnceWith(
      actor,
      context,
      batchId,
      root,
      { chainId: 31337, contractAddress },
    );
    expect(transport.broadcastSignedTransaction).toHaveBeenCalledTimes(1);
  });

  it("AC-DR02 denies a foreign actor before lookup, claim or send", async () => {
    const { persistence, client, transport } = fixture();
    persistence.getBatch.mockRejectedValueOnce(new Error("Invoice not found"));

    await expect(
      createEvidenceAnchor(persistence, client).anchorBatch(
        { ...actor, id: "outsider" },
        context,
        batchId,
      ),
    ).rejects.toThrow("Invoice not found");
    expect(transport.isRootRegistered).not.toHaveBeenCalled();
    expect(persistence.claimAnchorSubmission).not.toHaveBeenCalled();
    expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("AC-DR03 blocks a second orchestrator using a shared claim boundary", async () => {
    const { persistence, client, transport } = fixture();
    let reserved = false;
    persistence.claimAnchorSubmission.mockImplementation(async () => {
      if (reserved) return { kind: "blocked" };
      reserved = true;
      return {
        kind: "acquired" as const,
        reservationId: "reservation-1",
        claimToken: "token-1",
      };
    });
    const first = createEvidenceAnchor(persistence, client);
    const second = createEvidenceAnchor(persistence, client);

    const outcomes = await Promise.allSettled([
      first.anchorBatch(actor, context, batchId),
      second.anchorBatch(actor, context, batchId),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(persistence.claimAnchorSubmission).toHaveBeenCalledTimes(2);
    expect(transport.broadcastSignedTransaction).toHaveBeenCalledTimes(1);
  });

  it("AC-DR04 does not resend after an ambiguous result even with a fresh orchestrator", async () => {
    const { persistence, client, transport } = fixture();
    let reserved = false;
    persistence.claimAnchorSubmission.mockImplementation(async () => {
      if (reserved) return { kind: "blocked" };
      reserved = true;
      return {
        kind: "acquired" as const,
        reservationId: "reservation-1",
        claimToken: "token-1",
      };
    });
    transport.broadcastSignedTransaction.mockRejectedValueOnce(
      new Error("Outcome unknown"),
    );

    await expect(
      createEvidenceAnchor(persistence, client).anchorBatch(
        actor,
        context,
        batchId,
      ),
    ).rejects.toThrow("Outcome unknown");
    await expect(
      createEvidenceAnchor(persistence, client).anchorBatch(
        actor,
        context,
        batchId,
      ),
    ).rejects.toThrow("already claimed");
    expect(transport.broadcastSignedTransaction).toHaveBeenCalledTimes(1);
  });
});
