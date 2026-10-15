import { describe, expect, it, vi } from "vitest";
import { encodeEventTopics, encodeFunctionData, type Hex } from "viem";

import { registerRootAbi } from "../src/evidence-anchor-client.js";
import {
  createEvidenceAnchorReconciliation,
  type AnchorObservation,
  type ChainTransaction,
  type ChainReceipt,
} from "../src/evidence-anchor-reconciliation.js";
import { rootRegisteredAbi } from "../src/evidence-anchor-reconciliation-viem.js";

const root = `0x${"ab".repeat(32)}` as Hex;
const hash = `0x${"cd".repeat(32)}` as Hex;
const blockHash = `0x${"ef".repeat(32)}` as Hex;
const signer = `0x${"11".repeat(20)}` as Hex;
const contract = `0x${"22".repeat(20)}` as Hex;
const actor = { id: "actor", name: "Actor", rut: "123456785" };
const context = {
  organizationId: "org",
  ownerType: "user" as const,
  ownerId: "actor",
};
const prepared = {
  reservationId: "reservation",
  chainId: 31337,
  signerAddress: signer,
  contractAddress: contract,
  rootHash: root,
  transactionHash: hash,
  nonce: 7n,
  gas: 90_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};
const tx: ChainTransaction = {
  hash,
  chainId: 31337,
  type: "eip1559" as const,
  from: signer,
  to: contract,
  input: encodeFunctionData({
    abi: registerRootAbi,
    functionName: "registerRoot",
    args: [root],
  }),
  nonce: 7,
  gas: 90_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  value: 0n,
  blockHash,
  blockNumber: 4n,
};
const eventTopics = (rootHash: Hex, eventSigner: Hex) =>
  encodeEventTopics({
    abi: rootRegisteredAbi,
    eventName: "RootRegistered",
    args: { rootHash, signer: eventSigner },
  }).filter((topic): topic is Hex => typeof topic === "string");
const topics = eventTopics(root, signer);
const log = {
  address: contract,
  topics,
  data: "0x" as Hex,
  transactionHash: hash,
  blockHash,
  blockNumber: 4n,
  removed: false,
};
const receipt: ChainReceipt = {
  transactionHash: hash,
  from: signer,
  to: contract,
  status: "success",
  blockHash,
  blockNumber: 4n,
  logs: [log],
};

function fixture() {
  const history: AnchorObservation[] = [];
  const store = {
    readPrepared: vi.fn(async () => prepared),
    latest: vi.fn(
      async () =>
        history
          .filter((entry) =>
            ["observedSuccess", "observedRevert", "orphaned"].includes(
              entry.kind,
            ),
          )
          .at(-1)?.kind ?? null,
    ),
    append: vi.fn(
      async (
        _actor: typeof actor,
        _context: typeof context,
        _batchId: string,
        _reservationId: string,
        observation: AnchorObservation,
      ) => {
        history.push(observation);
        return observation;
      },
    ),
  };
  const reader = {
    getChainId: vi.fn(async () => 31337),
    getContractSigner: vi.fn(async () => signer),
    getTransaction: vi.fn(async (): Promise<ChainTransaction | null> => tx),
    getReceipt: vi.fn(async (): Promise<ChainReceipt | null> => receipt),
    getCanonicalBlock: vi.fn(async () => ({ number: 4n, hash: blockHash })),
  };
  const reconcile = createEvidenceAnchorReconciliation(store, reader);
  const check = () => reconcile.check(actor, context, "batch", "reservation");
  return { store, reader, history, check };
}

describe("TX06 read-only own-transaction reconciliation", () => {
  it("records only a canonical own success and never calls a write/nonce method", async () => {
    const { check, reader, history } = fixture();
    await expect(check()).resolves.toMatchObject({ kind: "observedSuccess" });
    expect(history).toHaveLength(1);
    expect(reader.getTransaction).toHaveBeenCalledExactlyOnceWith(hash);
    expect(reader.getReceipt).toHaveBeenCalledExactlyOnceWith(hash);
    expect(reader.getCanonicalBlock).toHaveBeenCalledExactlyOnceWith(4n);
  });

  it("refuses foreign access before RPC or append", async () => {
    const { store, reader, check } = fixture();
    store.readPrepared.mockRejectedValueOnce(
      new Error("Evidence batch not found"),
    );
    await expect(check()).rejects.toThrow("Evidence batch not found");
    expect(reader.getChainId).not.toHaveBeenCalled();
    expect(store.append).not.toHaveBeenCalled();
  });

  it.each([
    ["hash", { hash: root }],
    ["sender", { from: contract }],
    ["target", { to: signer }],
    ["calldata", { input: "0x" }],
    ["nonce", { nonce: 8 }],
    ["chain", { chainId: 1 }],
    ["gas", { gas: 80_000n }],
    ["fee", { maxFeePerGas: 3n }],
    ["value", { value: 1n }],
    ["type", { type: "legacy" }],
  ])("treats mismatched %s as needsReview", async (_field, change) => {
    const { check, reader } = fixture();
    reader.getTransaction.mockResolvedValueOnce({ ...tx, ...change });
    await expect(check()).resolves.toMatchObject({ kind: "needsReview" });
  });

  it.each([
    [
      "event signer",
      { logs: [{ ...log, topics: eventTopics(root, contract) }] },
    ],
    ["event contract", { logs: [{ ...log, address: signer }] }],
    ["removed log", { logs: [{ ...log, removed: true }] }],
    ["missing event", { logs: [] }],
    ["duplicate event", { logs: [log, log] }],
    ["wrong root", { logs: [{ ...log, topics: eventTopics(hash, signer) }] }],
    ["receipt hash", { transactionHash: root }],
  ])("rejects %s on success receipt", async (_case, change) => {
    const { check, reader } = fixture();
    reader.getReceipt.mockResolvedValueOnce({ ...receipt, ...change });
    await expect(check()).resolves.toMatchObject({ kind: "needsReview" });
  });

  it.each([
    ["extra topic", { ...log, topics: [...topics, hash] }],
    ["nonempty event data", { ...log, data: "0x01" as Hex }],
  ])("rejects valid root and signer with %s", async (_case, malformedLog) => {
    const { check, reader, history } = fixture();
    reader.getReceipt.mockResolvedValueOnce({
      ...receipt,
      logs: [malformedLog],
    });
    await expect(check()).resolves.toMatchObject({
      kind: "needsReview",
      reason: "eventMismatch",
    });
    expect(history).toEqual([
      expect.objectContaining({ kind: "needsReview", reason: "eventMismatch" }),
    ]);
  });

  it("rejects noncanonical indexed signer padding even when viem decodes the expected signer", async () => {
    const { check, reader } = fixture();
    reader.getReceipt.mockResolvedValueOnce({
      ...receipt,
      logs: [
        {
          ...log,
          topics: [
            topics[0],
            topics[1],
            `0x${"ff".repeat(12)}${signer.slice(2)}` as Hex,
          ],
        },
      ],
    });
    await expect(check()).resolves.toMatchObject({
      kind: "needsReview",
      reason: "eventMismatch",
    });
  });

  it("records revert only for an identified canonical receipt", async () => {
    const { check, reader } = fixture();
    reader.getReceipt.mockResolvedValueOnce({
      ...receipt,
      status: "reverted",
      logs: [],
    });
    await expect(check()).resolves.toMatchObject({ kind: "observedRevert" });
  });

  it("appends contrary evidence after a reorg and a missing transaction", async () => {
    const { check, reader, history } = fixture();
    await check();
    reader.getCanonicalBlock.mockResolvedValueOnce({ number: 4n, hash: root });
    await expect(check()).resolves.toMatchObject({ kind: "orphaned" });
    reader.getTransaction.mockResolvedValueOnce(null);
    await expect(check()).resolves.toMatchObject({ kind: "needsReview" });
    expect(history.map(({ kind }) => kind)).toEqual([
      "observedSuccess",
      "orphaned",
      "needsReview",
    ]);
  });

  it("keeps missing receipt provisional and failures separate from absence", async () => {
    const { check, reader, history } = fixture();
    reader.getReceipt.mockResolvedValueOnce(null);
    await expect(check()).resolves.toMatchObject({ kind: "pending" });
    reader.getReceipt.mockRejectedValueOnce(new Error("private RPC payload"));
    await expect(check()).resolves.toMatchObject({
      kind: "needsReview",
      reason: "rpcUnavailable",
    });
    expect(JSON.stringify(history)).not.toContain("private RPC payload");
  });

  it("does not report persisted success if append fails", async () => {
    const { check, store } = fixture();
    store.append.mockRejectedValueOnce(new Error("write failed"));
    await expect(check()).rejects.toThrow("write failed");
  });
});
