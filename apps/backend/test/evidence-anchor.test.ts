import { describe, expect, it, vi } from "vitest";

import { createEvidenceAnchorClient } from "../src/evidence-anchor-client.js";
import type { AnchorClaimResult } from "../src/evidence-anchor-reservation.js";
import { createEvidenceAnchor } from "../src/evidence-anchor.js";
import {
  durablePreparationPorts,
  fixtureSigner,
  signedAnchorTransport,
} from "./evidence-anchor-fixture.js";

const ROOT = `0x${"a1".repeat(32)}`;
const CONTRACT = `0x${"12".repeat(20)}`;
const SIGNER = fixtureSigner;
const actor = { id: "actor-1", name: "Test actor", rut: "123456785" };
const context = {
  organizationId: "org-1",
  ownerType: "user" as const,
  ownerId: "actor-1",
};
const batchId = "batch-1";

// Proposed internal boundary: getBatch represents the existing authorized,
// revalidating evidence persistence read, not a raw caller-provided root.
function fixture(withClaim = true) {
  const persistence = {
    getBatch: vi.fn(async () => ({
      id: batchId,
      rootHash: ROOT,
      leafCount: 1,
      policyVersion: "invoice-merkle-v2",
    })),
    claimAnchorSubmission: vi.fn(async (): Promise<AnchorClaimResult> => ({
      kind: "acquired",
      reservationId: "reservation-1",
      claimToken: "token-1",
    })),
    ...durablePreparationPorts(),
  };
  const transport = {
    getChainId: vi.fn(async () => 31337),
    getSignerAddress: vi.fn(async () => SIGNER),
    getContractSigner: vi.fn(async () => SIGNER),
    isRootRegistered: vi.fn(async () => false),
    ...signedAnchorTransport(ROOT, CONTRACT),
  };
  const client = createEvidenceAnchorClient(
    { chainId: 31337, contractAddress: CONTRACT, signerAddress: SIGNER },
    transport,
  );
  const anchor = createEvidenceAnchor(
    withClaim ? persistence : { getBatch: persistence.getBatch },
    client,
  );
  return { anchor, persistence, transport };
}

describe("APP-11 anchor orchestration preimplementation contract", () => {
  it("AC02 does not equate a failed chain lookup with an unregistered root", async () => {
    const { anchor, persistence, transport } = fixture();
    transport.isRootRegistered.mockRejectedValueOnce(
      new Error("RPC unavailable"),
    );

    await expect(anchor.anchorBatch(actor, context, batchId)).rejects.toThrow(
      "RPC unavailable",
    );
    expect(persistence.getBatch).toHaveBeenCalledWith(actor, context, batchId);
    expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("AC03 registers only the root from the authorized, revalidated batch", async () => {
    const { anchor, persistence, transport } = fixture();

    await anchor.anchorBatch(actor, context, batchId);
    expect(persistence.getBatch).toHaveBeenCalledWith(actor, context, batchId);
    expect(transport.isRootRegistered).toHaveBeenCalledWith(CONTRACT, ROOT);
    expect(transport.prepareRootRegistration).toHaveBeenCalledExactlyOnceWith(
      CONTRACT,
      ROOT,
      7,
    );
    expect(transport.broadcastSignedTransaction).toHaveBeenCalledTimes(1);
  });

  it("AC05 fails closed without a durable claim capability", async () => {
    const { anchor, transport } = fixture(false);
    await expect(anchor.anchorBatch(actor, context, batchId)).rejects.toThrow(
      "Durable evidence anchor submission claim unavailable",
    );
    expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("AC02 does not submit an already registered root", async () => {
    const { anchor, transport } = fixture();
    transport.isRootRegistered.mockResolvedValueOnce(true);

    await anchor.anchorBatch(actor, context, batchId);
    expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("AC03 never sends when batch ownership or integrity validation fails", async () => {
    const { anchor, persistence, transport } = fixture();
    persistence.getBatch.mockRejectedValueOnce(
      new Error("Evidence integrity verification failed"),
    );

    await expect(anchor.anchorBatch(actor, context, batchId)).rejects.toThrow();
    expect(transport.isRootRegistered).not.toHaveBeenCalled();
    expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("AC05 does not send again after an ambiguous submission failure", async () => {
    const { anchor, persistence, transport } = fixture();
    let claimed = false;
    persistence.claimAnchorSubmission.mockImplementation(async () => {
      if (claimed) return { kind: "blocked" };
      claimed = true;
      return {
        kind: "acquired" as const,
        reservationId: "reservation-1",
        claimToken: "token-1",
      };
    });
    transport.broadcastSignedTransaction.mockRejectedValueOnce(
      new Error("Submission outcome unknown"),
    );

    await expect(anchor.anchorBatch(actor, context, batchId)).rejects.toThrow();
    await expect(anchor.anchorBatch(actor, context, batchId)).rejects.toThrow();
    expect(persistence.claimAnchorSubmission).toHaveBeenCalledTimes(2);
    expect(transport.broadcastSignedTransaction).toHaveBeenCalledTimes(1);
  });

  it("AC05 suppresses overlapping attempts for the same batch", async () => {
    const { anchor, persistence, transport } = fixture();
    let claimed = false;
    persistence.claimAnchorSubmission.mockImplementation(async () => {
      if (claimed) return { kind: "blocked" };
      claimed = true;
      return {
        kind: "acquired" as const,
        reservationId: "reservation-1",
        claimToken: "token-1",
      };
    });
    let release!: () => void;
    let submitted!: () => void;
    const started = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    transport.broadcastSignedTransaction.mockImplementationOnce(
      async (bytes) => {
        submitted();
        await pending;
        return (await import("viem")).keccak256(bytes);
      },
    );

    const first = anchor.anchorBatch(actor, context, batchId);
    await Promise.race([
      started,
      first.then(
        () => {
          throw new Error("Submission did not start");
        },
        () => {
          throw new Error("Submission did not start");
        },
      ),
    ]);
    const second = anchor.anchorBatch(actor, context, batchId);
    try {
      await expect(second).rejects.toThrow("already claimed");
      expect(persistence.claimAnchorSubmission).toHaveBeenCalledTimes(2);
      expect(transport.broadcastSignedTransaction).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    await first;
    expect(transport.broadcastSignedTransaction).toHaveBeenCalledTimes(1);
  });
});
