import { describe, expect, it, vi } from "vitest";
import {
  encodeFunctionData,
  keccak256,
  parseTransaction,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  createEvidenceAnchorClient,
  registerRootAbi,
  verifyPreparedAnchorTransaction,
} from "../src/evidence-anchor-client.js";
import { createEvidenceAnchor } from "../src/evidence-anchor.js";
import { createViemEvidenceAnchorTransport } from "../src/evidence-anchor-viem.js";

const root = `0x${"ab".repeat(32)}` as Hex;
const contractAddress = `0x${"12".repeat(20)}`;
const account = privateKeyToAccount(generatePrivateKey());
const signerAddress = account.address.toLowerCase();
const actor = { id: "actor-1", name: "Actor", rut: "123456785" };
const context = {
  organizationId: "org-1",
  ownerType: "user" as const,
  ownerId: actor.id,
};
const batchId = "batch-1";
const reservationId = "reservation-1";
const claimToken = "claim-token-1";
const data = encodeFunctionData({
  abi: registerRootAbi,
  functionName: "registerRoot",
  args: [root],
});
const signedTransaction = await account.signTransaction({
  type: "eip1559",
  chainId: 31337,
  nonce: 7,
  to: contractAddress as Hex,
  data,
  value: 0n,
  gas: 90_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
});
const transactionHash = keccak256(signedTransaction);

function fixture() {
  const persistence = {
    getBatch: vi.fn(async () => ({
      id: batchId,
      rootHash: root,
      leafCount: 1,
      policyVersion: "invoice-merkle-v2",
    })),
    claimAnchorSubmission: vi.fn(async () => ({
      kind: "acquired" as const,
      reservationId,
      claimToken,
    })),
    acquireSignerPreparationSlot: vi.fn(async () => {}),
    persistPreparedTransaction: vi.fn(async () => {}),
  };
  const calls: string[] = [];
  const transport = {
    getChainId: vi.fn(async () => 31337),
    getSignerAddress: vi.fn(async () => signerAddress),
    getContractSigner: vi.fn(async () => signerAddress),
    isRootRegistered: vi.fn(async () => false),
    getPendingNonce: vi.fn(async () => {
      calls.push("nonce");
      return 7;
    }),
    prepareRootRegistration: vi.fn(async () => {
      calls.push("sign");
      return signedTransaction;
    }),
    broadcastSignedTransaction: vi.fn(async () => {
      calls.push("broadcast");
      return transactionHash;
    }),
  };
  const client = createEvidenceAnchorClient(
    { chainId: 31337, contractAddress, signerAddress },
    transport,
  );
  return {
    anchor: createEvidenceAnchor(persistence, client),
    persistence,
    transport,
    calls,
  };
}

describe("APP-11 offline signed preparation and exact broadcast", () => {
  it("TX02 accepts a valid zero-priority-fee EIP-1559 transaction without changing its intent", async () => {
    const zeroTipTransaction = await account.signTransaction({
      type: "eip1559",
      chainId: 31337,
      nonce: 0,
      to: contractAddress as Hex,
      data,
      value: 0n,
      gas: 90_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 0n,
    });

    const prepared = await verifyPreparedAnchorTransaction(zeroTipTransaction, {
      chainId: 31337,
      contractAddress,
      signerAddress,
      root,
      nonce: 0,
    });

    expect(parseTransaction(zeroTipTransaction).maxPriorityFeePerGas).toBe(
      undefined,
    );
    expect(prepared).toMatchObject({
      chainId: 31337,
      contractAddress,
      signerAddress,
      root,
      nonce: 0,
      gas: 90_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 0n,
    });
    expect(prepared.signedTransaction).toBe(zeroTipTransaction);
  });

  it("TX04 acquires durable signer exclusivity before any nonce or signing RPC", async () => {
    const { anchor, persistence, transport } = fixture();
    persistence.acquireSignerPreparationSlot.mockRejectedValueOnce(
      new Error("Signer preparation slot occupied"),
    );
    await expect(anchor.anchorBatch(actor, context, batchId)).rejects.toThrow(
      "Signer preparation slot occupied",
    );
    expect(
      persistence.acquireSignerPreparationSlot,
    ).toHaveBeenCalledExactlyOnceWith(
      actor,
      context,
      batchId,
      root,
      { chainId: 31337, contractAddress },
      reservationId,
      claimToken,
      signerAddress,
    );
    expect(transport.getPendingNonce).not.toHaveBeenCalled();
    expect(transport.prepareRootRegistration).not.toHaveBeenCalled();
    expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("TX03 does not broadcast when durable prepared metadata fails", async () => {
    const { anchor, persistence, transport } = fixture();
    persistence.persistPreparedTransaction.mockRejectedValueOnce(
      new Error("Prepared transaction persistence failed"),
    );
    await expect(anchor.anchorBatch(actor, context, batchId)).rejects.toThrow(
      "Prepared transaction persistence failed",
    );
    expect(persistence.persistPreparedTransaction).toHaveBeenCalledWith(
      actor,
      context,
      batchId,
      reservationId,
      claimToken,
      expect.objectContaining({ transactionHash, nonce: 7, gas: 90_000n }),
    );
    expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("TX03 commits computed hash before broadcasting precisely the validated signed bytes", async () => {
    const { anchor, persistence, transport, calls } = fixture();
    persistence.acquireSignerPreparationSlot.mockImplementationOnce(
      async () => {
        calls.push("slot");
      },
    );
    persistence.persistPreparedTransaction.mockImplementationOnce(async () => {
      calls.push("commit");
    });
    await expect(anchor.anchorBatch(actor, context, batchId)).resolves.toBe(
      "broadcastedUnknown",
    );
    expect(calls).toEqual(["slot", "nonce", "sign", "commit", "broadcast"]);
    expect(
      transport.broadcastSignedTransaction,
    ).toHaveBeenCalledExactlyOnceWith(signedTransaction);
    expect(persistence.persistPreparedTransaction).toHaveBeenCalledWith(
      actor,
      context,
      batchId,
      reservationId,
      claimToken,
      expect.not.objectContaining({ signedTransaction: expect.anything() }),
    );
  });

  it("TX02 rejects altered chain, sender, calldata, nonce, fees and malformed payload without broadcasting", async () => {
    const { anchor, transport } = fixture();
    const changes = [
      { chainId: 1 },
      { nonce: 8 },
      { to: signerAddress as Hex },
      { data: "0xdeadbeef" as Hex },
      { value: 1n },
      { gas: 20_999n },
      { gas: 3_000_001n },
      { maxFeePerGas: 0n },
      { maxFeePerGas: 1_000_000_000_001n },
    ];
    for (const changed of changes) {
      const bad = await account.signTransaction({
        type: "eip1559",
        chainId: 31337,
        nonce: 7,
        to: contractAddress as Hex,
        data,
        value: 0n,
        gas: 90_000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        ...changed,
      });
      transport.prepareRootRegistration.mockResolvedValueOnce(bad);
      await expect(
        anchor.anchorBatch(actor, context, batchId),
      ).rejects.toThrow();
    }
    for (const malformed of [
      "0xdead",
      "0x02c0",
      `${signedTransaction.slice(0, -2)}`,
    ] as Hex[]) {
      transport.prepareRootRegistration.mockResolvedValueOnce(malformed);
      await expect(
        anchor.anchorBatch(actor, context, batchId),
      ).rejects.toThrow();
    }
    const alteredSignature =
      `${signedTransaction.slice(0, -2)}${signedTransaction.endsWith("00") ? "01" : "00"}` as Hex;
    transport.prepareRootRegistration.mockResolvedValueOnce(alteredSignature);
    await expect(anchor.anchorBatch(actor, context, batchId)).rejects.toThrow();
    const legacy = await account.signTransaction({
      type: "legacy",
      chainId: 31337,
      nonce: 7,
      to: contractAddress as Hex,
      data,
      value: 0n,
      gas: 90_000n,
      gasPrice: 2_000_000_000n,
    });
    transport.prepareRootRegistration.mockResolvedValueOnce(legacy);
    await expect(anchor.anchorBatch(actor, context, batchId)).rejects.toThrow(
      "EIP-1559",
    );
    const foreign = privateKeyToAccount(generatePrivateKey());
    transport.prepareRootRegistration.mockResolvedValueOnce(
      await foreign.signTransaction({
        type: "eip1559",
        chainId: 31337,
        nonce: 7,
        to: contractAddress as Hex,
        data,
        value: 0n,
        gas: 90_000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
    );
    await expect(anchor.anchorBatch(actor, context, batchId)).rejects.toThrow();
    expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("TX03 treats returned hash mismatch or transport uncertainty as indeterminate without retry", async () => {
    const { anchor, persistence, transport } = fixture();
    transport.broadcastSignedTransaction.mockResolvedValueOnce(
      `0x${"00".repeat(32)}` as Hex,
    );
    await expect(anchor.anchorBatch(actor, context, batchId)).rejects.toThrow(
      "outcome unknown",
    );
    expect(persistence.persistPreparedTransaction).toHaveBeenCalledTimes(1);
    expect(transport.broadcastSignedTransaction).toHaveBeenCalledTimes(1);
  });

  it("TX02 refuses forged prepared hash before raw send", async () => {
    const { transport } = fixture();
    const client = createEvidenceAnchorClient(
      { chainId: 31337, contractAddress, signerAddress },
      transport,
    );
    const prepared = await client.prepareRootRegistration(root);
    await expect(
      client.broadcastPrepared({
        ...prepared,
        transactionHash: `0x${"00".repeat(32)}`,
      }),
    ).rejects.toThrow("Prepared hash mismatch");
    expect(transport.broadcastSignedTransaction).not.toHaveBeenCalled();
  });

  it("TX02 viem adapter uses pending nonce and sends only the signed EIP-1559 transaction to injected RPC", async () => {
    const methods: string[] = [];
    const rawRequests: unknown[] = [];
    const adapter = createViemEvidenceAnchorTransport(31337, account, {
      async request({ method, params }) {
        methods.push(method);
        if (method === "eth_getTransactionCount") {
          expect(params).toEqual([signerAddress, "pending"]);
          return "0x7";
        }
        if (method === "eth_estimateGas") return "0x15f90";
        if (method === "eth_getBlockByNumber")
          return { baseFeePerGas: "0x3b9aca00", gasLimit: "0x1c9c380" };
        if (method === "eth_maxPriorityFeePerGas") return "0x3b9aca00";
        if (method === "eth_gasPrice") return "0x77359400";
        if (method === "eth_sendRawTransaction") {
          rawRequests.push(params);
          return transactionHash;
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
    });
    expect(await adapter.getPendingNonce(signerAddress)).toBe(7);
    const raw = await adapter.prepareRootRegistration(contractAddress, root, 7);
    expect(parseTransaction(raw).type).toBe("eip1559");
    expect(
      (
        await verifyPreparedAnchorTransaction(raw, {
          chainId: 31337,
          contractAddress,
          signerAddress,
          root,
          nonce: 7,
        })
      ).transactionHash,
    ).toBe(keccak256(raw));
    expect(methods).not.toContain("eth_sendRawTransaction");
    await expect(adapter.broadcastSignedTransaction(raw)).resolves.toBe(
      transactionHash,
    );
    expect(rawRequests).toEqual([[raw]]);
    expect(
      methods.filter((method) => method === "eth_sendRawTransaction"),
    ).toHaveLength(1);
  });
});
