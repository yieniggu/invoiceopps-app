import { describe, expect, it, vi } from "vitest";

import { createEvidenceAnchorClient } from "../src/evidence-anchor-client.js";
import {
  fixtureSigner,
  signedAnchorTransport,
} from "./evidence-anchor-fixture.js";

const ROOT = `0x${"a1".repeat(32)}`;
const CONTRACT = `0x${"12".repeat(20)}`;
const SIGNER = fixtureSigner;
const OTHER_SIGNER = `0x${"56".repeat(20)}`;

// Proposed internal boundary: transport reads chain/contract/signer identity and
// contract state; only registerRoot may send. No wallet or RPC is constructed here.
function fixture() {
  const transport = {
    getChainId: vi.fn(async () => 31337),
    getSignerAddress: vi.fn(async () => SIGNER),
    getContractSigner: vi.fn(async (_contractAddress: string) => SIGNER),
    isRootRegistered: vi.fn(
      async (_contractAddress: string, _root: string) => false,
    ),
    ...signedAnchorTransport(ROOT, CONTRACT),
  };
  const config = {
    chainId: 31337,
    contractAddress: CONTRACT,
    signerAddress: SIGNER,
  };
  return { config, transport };
}

describe("APP-11 anchor client preimplementation contract", () => {
  it("AC01 refuses chain mismatch without submitting a transaction", async () => {
    const { config, transport } = fixture();
    transport.getChainId.mockResolvedValue(1);
    const client = createEvidenceAnchorClient(config, transport);

    await expect(client.prepareRootRegistration(ROOT)).rejects.toThrow();
    expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("AC01 refuses a signer that does not match the configured or immutable contract signer", async () => {
    for (const mismatch of ["wallet", "contract"] as const) {
      const { config, transport } = fixture();
      if (mismatch === "wallet") {
        transport.getSignerAddress.mockResolvedValue(OTHER_SIGNER);
      } else {
        transport.getContractSigner.mockResolvedValue(OTHER_SIGNER);
      }
      const client = createEvidenceAnchorClient(config, transport);

      await expect(client.prepareRootRegistration(ROOT)).rejects.toThrow();
      expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
    }
  });

  it("AC01 rejects invalid server configuration before any send", async () => {
    const { config, transport } = fixture();
    expect(() =>
      createEvidenceAnchorClient(
        { ...config, contractAddress: "invalid" },
        transport,
      ),
    ).toThrow();
    expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("AC02 returns an actual negative lookup but propagates a failed RPC read", async () => {
    const { config, transport } = fixture();
    const client = createEvidenceAnchorClient(config, transport);

    await expect(client.isRootRegistered(ROOT)).resolves.toBe(false);
    expect(transport.isRootRegistered).toHaveBeenCalledWith(CONTRACT, ROOT);
    transport.isRootRegistered.mockRejectedValueOnce(
      new Error("RPC unavailable"),
    );
    await expect(client.isRootRegistered(ROOT)).rejects.toThrow(
      "RPC unavailable",
    );
    expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("AC03 sends the exact 32-byte root to the configured contract after identity checks", async () => {
    const { config, transport } = fixture();
    const client = createEvidenceAnchorClient(config, transport);

    const prepared = await client.prepareRootRegistration(ROOT);
    expect(prepared.root).toBe(ROOT);
    expect(prepared.signerAddress).toBe(SIGNER);
    expect(transport.prepareRootRegistration).toHaveBeenCalledExactlyOnceWith(
      CONTRACT,
      ROOT,
      7,
    );
    expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("keeps target identity immutable after caller config mutation", async () => {
    const { config, transport } = fixture();
    const client = createEvidenceAnchorClient(config, transport);
    config.chainId = 1;
    config.contractAddress = OTHER_SIGNER;
    config.signerAddress = OTHER_SIGNER;
    expect(client.getTarget()).toEqual({
      chainId: 31337,
      contractAddress: CONTRACT,
    });
    await client.prepareRootRegistration(ROOT);
    expect(transport.prepareRootRegistration).toHaveBeenCalledExactlyOnceWith(
      CONTRACT,
      ROOT,
      7,
    );
  });
});
