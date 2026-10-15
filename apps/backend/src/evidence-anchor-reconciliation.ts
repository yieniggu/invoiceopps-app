import {
  decodeEventLog,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
} from "viem";

import type { AuthUser } from "./auth.js";
import { registerRootAbi } from "./evidence-anchor-client.js";
import { rootRegisteredAbi } from "./evidence-anchor-reconciliation-viem.js";
import type { ResourceContext } from "./resources.js";

export type ObservationKind =
  "pending" | "needsReview" | "orphaned" | "observedRevert" | "observedSuccess";
export type ObservationReason =
  | "transactionMissing"
  | "receiptMissing"
  | "missingAfterObservation"
  | "rpcUnavailable"
  | "identityMismatch"
  | "receiptMismatch"
  | "eventMismatch"
  | "canonicalMismatch"
  | "reverted"
  | "matched";
export interface AnchorObservation {
  kind: ObservationKind;
  reason: ObservationReason;
  blockNumber?: bigint;
  blockHash?: string;
  receiptStatus?: "success" | "reverted";
}
export interface StoredAnchor {
  reservationId: string;
  chainId: number;
  signerAddress: string;
  contractAddress: string;
  rootHash: string;
  transactionHash: string;
  nonce: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
interface Store {
  readPrepared(
    actor: AuthUser,
    context: ResourceContext,
    batchId: string,
    reservationId: string,
  ): Promise<StoredAnchor>;
  latest(
    actor: AuthUser,
    context: ResourceContext,
    batchId: string,
    reservationId: string,
  ): Promise<ObservationKind | null>;
  append(
    actor: AuthUser,
    context: ResourceContext,
    batchId: string,
    reservationId: string,
    observation: AnchorObservation,
  ): Promise<AnchorObservation>;
}
export interface ChainReader {
  getChainId(): Promise<number>;
  getContractSigner(address: string): Promise<string>;
  getTransaction(hash: string): Promise<null | ChainTransaction>;
  getReceipt(hash: string): Promise<null | ChainReceipt>;
  getCanonicalBlock(
    number: bigint,
  ): Promise<{ number: bigint | null; hash: string | null }>;
}
export interface ChainTransaction {
  hash: string;
  chainId?: number | null;
  type: string;
  from: string;
  to: string | null;
  input: string;
  nonce: number;
  gas: bigint;
  maxFeePerGas?: bigint | null;
  maxPriorityFeePerGas?: bigint | null;
  value: bigint;
  blockHash: string | null;
  blockNumber: bigint | null;
}
export interface ChainReceipt {
  transactionHash: string;
  from: string;
  to: string | null;
  status: string;
  blockHash: string;
  blockNumber: bigint;
  logs: readonly {
    address: string;
    topics: readonly Hex[];
    data: Hex;
    transactionHash: string | null;
    blockHash: string | null;
    blockNumber: bigint | null;
    removed?: boolean;
  }[];
}
const address = /^0x[0-9a-fA-F]{40}$/;
const hash = /^0x[0-9a-fA-F]{64}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const positive = (n: bigint) => n >= 0n && n <= 9_007_199_254_740_991n;

export function createEvidenceAnchorReconciliation(
  store: Store,
  reader: ChainReader,
) {
  return {
    async check(
      actor: AuthUser,
      context: ResourceContext,
      batchId: string,
      reservationId: string,
      expectedTarget?: { chainId: number; contractAddress: string },
    ): Promise<AnchorObservation> {
      // Authorization and batch reconstruction happen before any provider request.
      const own = await store.readPrepared(
        actor,
        context,
        batchId,
        reservationId,
      );
      const previous = await store.latest(
        actor,
        context,
        batchId,
        reservationId,
      );
      if (
        !hash.test(own.transactionHash) ||
        !hash.test(own.rootHash) ||
        !address.test(own.signerAddress) ||
        !address.test(own.contractAddress) ||
        !Number.isSafeInteger(own.chainId) ||
        own.chainId <= 0 ||
        !positive(own.nonce)
      )
        throw new Error("Invalid persisted evidence transaction identity");
      if (
        expectedTarget &&
        (own.chainId !== expectedTarget.chainId ||
          !same(own.contractAddress, expectedTarget.contractAddress))
      )
        throw new Error(
          "Evidence anchor target does not match prepared transaction",
        );
      let observation: AnchorObservation;
      try {
        const chain = await reader.getChainId();
        if (chain !== own.chainId)
          observation = { kind: "needsReview", reason: "identityMismatch" };
        else {
          const signer = await reader.getContractSigner(own.contractAddress);
          if (!address.test(signer) || !same(signer, own.signerAddress))
            observation = { kind: "needsReview", reason: "identityMismatch" };
          else observation = await inspect(own, previous, reader);
        }
      } catch {
        // Never expose provider errors or misclassify transport failures as absence.
        observation = { kind: "needsReview", reason: "rpcUnavailable" };
      }
      // Store reauthorizes and copies identity from its own prepared row, never RPC data.
      return store.append(actor, context, batchId, reservationId, observation);
    },
  };
}

async function inspect(
  own: StoredAnchor,
  previous: ObservationKind | null,
  reader: ChainReader,
): Promise<AnchorObservation> {
  const tx = await reader.getTransaction(own.transactionHash);
  if (!tx)
    return previous && previous !== "pending"
      ? { kind: "needsReview", reason: "missingAfterObservation" }
      : { kind: "pending", reason: "transactionMissing" };
  const calldata = encodeFunctionData({
    abi: registerRootAbi,
    functionName: "registerRoot",
    args: [own.rootHash as Hex],
  });
  if (
    !hash.test(tx.hash) ||
    !address.test(tx.from) ||
    !tx.to ||
    !address.test(tx.to) ||
    !same(tx.hash, own.transactionHash) ||
    tx.chainId !== own.chainId ||
    tx.type !== "eip1559" ||
    !same(tx.from, own.signerAddress) ||
    !same(tx.to, own.contractAddress) ||
    !same(tx.input, calldata) ||
    !Number.isSafeInteger(tx.nonce) ||
    BigInt(tx.nonce) !== own.nonce ||
    tx.value !== 0n ||
    tx.gas !== own.gas ||
    tx.maxFeePerGas !== own.maxFeePerGas ||
    tx.maxPriorityFeePerGas !== own.maxPriorityFeePerGas
  )
    return { kind: "needsReview", reason: "identityMismatch" };
  const receipt = await reader.getReceipt(own.transactionHash);
  if (!receipt)
    return previous && previous !== "pending"
      ? { kind: "needsReview", reason: "missingAfterObservation" }
      : { kind: "pending", reason: "receiptMissing" };
  if (
    !hash.test(receipt.transactionHash) ||
    !same(receipt.transactionHash, own.transactionHash) ||
    !address.test(receipt.from) ||
    !same(receipt.from, own.signerAddress) ||
    !receipt.to ||
    !address.test(receipt.to) ||
    !same(receipt.to, own.contractAddress) ||
    !hash.test(receipt.blockHash) ||
    !positive(receipt.blockNumber) ||
    !tx.blockHash ||
    !hash.test(tx.blockHash) ||
    !same(tx.blockHash, receipt.blockHash) ||
    tx.blockNumber !== receipt.blockNumber ||
    !["success", "reverted"].includes(receipt.status)
  )
    return { kind: "needsReview", reason: "receiptMismatch" };
  const canonical = await reader.getCanonicalBlock(receipt.blockNumber);
  if (
    canonical.number !== receipt.blockNumber ||
    !canonical.hash ||
    !hash.test(canonical.hash) ||
    !same(canonical.hash, receipt.blockHash)
  )
    return { kind: "orphaned", reason: "canonicalMismatch" };
  const location = {
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
  };
  if (receipt.status === "reverted")
    return {
      kind: "observedRevert",
      reason: "reverted",
      receiptStatus: "reverted",
      ...location,
    };
  if (receipt.logs.length > 256)
    return { kind: "needsReview", reason: "eventMismatch" };
  const candidates = receipt.logs.filter(
    (log) =>
      address.test(log.address) && same(log.address, own.contractAddress),
  );
  if (
    candidates.some(
      (log) =>
        log.removed ||
        log.transactionHash === null ||
        !same(log.transactionHash, own.transactionHash) ||
        !log.blockHash ||
        !same(log.blockHash, receipt.blockHash) ||
        log.blockNumber !== receipt.blockNumber,
    )
  )
    return { kind: "needsReview", reason: "eventMismatch" };
  const signature = encodeEventTopics({
    abi: rootRegisteredAbi,
    eventName: "RootRegistered",
  })[0];
  const matches = candidates.filter(
    (log) =>
      Array.isArray(log.topics) &&
      typeof log.topics[0] === "string" &&
      same(log.topics[0], signature),
  );
  if (matches.length !== 1)
    return { kind: "needsReview", reason: "eventMismatch" };
  if (
    !Array.isArray(matches[0].topics) ||
    matches[0].topics.length !== 3 ||
    !matches[0].topics.every(
      (topic) => typeof topic === "string" && hash.test(topic),
    ) ||
    matches[0].data !== "0x"
  )
    return { kind: "needsReview", reason: "eventMismatch" };
  const canonicalTopics = encodeEventTopics({
    abi: rootRegisteredAbi,
    eventName: "RootRegistered",
    args: { rootHash: own.rootHash as Hex, signer: own.signerAddress as Hex },
  });
  if (
    canonicalTopics.length !== 3 ||
    !matches[0].topics.every((topic, index) => {
      const expected = canonicalTopics[index];
      return typeof expected === "string" && same(topic, expected);
    })
  )
    return { kind: "needsReview", reason: "eventMismatch" };
  let decoded;
  try {
    decoded = decodeEventLog({
      abi: rootRegisteredAbi,
      eventName: "RootRegistered",
      topics: matches[0].topics as [Hex, ...Hex[]],
      data: matches[0].data,
      strict: true,
    });
  } catch {
    return { kind: "needsReview", reason: "eventMismatch" };
  }
  if (
    !same(decoded.args.rootHash, own.rootHash) ||
    !same(decoded.args.signer, own.signerAddress)
  )
    return { kind: "needsReview", reason: "eventMismatch" };
  return {
    kind: "observedSuccess",
    reason: "matched",
    receiptStatus: "success",
    ...location,
  };
}
