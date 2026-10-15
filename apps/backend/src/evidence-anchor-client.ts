export interface EvidenceAnchorConfig {
  chainId: number;
  contractAddress: string;
  signerAddress: string;
}

export interface EvidenceAnchorTarget {
  chainId: number;
  contractAddress: string;
}

export interface EvidenceAnchorTransport {
  getChainId(): Promise<number>;
  getSignerAddress(): Promise<string>;
  getContractSigner(contractAddress: string): Promise<string>;
  isRootRegistered(contractAddress: string, root: string): Promise<boolean>;
  getPendingNonce(signerAddress: string): Promise<number>;
  prepareRootRegistration(
    contractAddress: string,
    root: Hex,
    nonce: number,
  ): Promise<Hex>;
  broadcastSignedTransaction(signedTransaction: Hex): Promise<Hex>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ROOT = /^0x[0-9a-fA-F]{64}$/;
export const registerRootAbi = [
  {
    type: "function",
    name: "registerRoot",
    stateMutability: "nonpayable",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [],
  },
] as const;

export interface PreparedAnchorTransaction {
  chainId: number;
  contractAddress: string;
  signerAddress: string;
  root: string;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  transactionHash: Hex;
  signedTransaction: Hex;
}

const MAX_GAS = 3_000_000n;
const MAX_FEE = 1_000_000_000_000n;

export async function verifyPreparedAnchorTransaction(
  serialized: Hex,
  expected: {
    chainId: number;
    contractAddress: string;
    signerAddress: string;
    root: string;
    nonce: number;
  },
): Promise<PreparedAnchorTransaction> {
  if (
    !/^0x[0-9a-fA-F]+$/.test(serialized) ||
    serialized.length > 8192 ||
    !ROOT.test(expected.root) ||
    !ADDRESS.test(expected.contractAddress) ||
    !ADDRESS.test(expected.signerAddress) ||
    !Number.isSafeInteger(expected.nonce) ||
    expected.nonce < 0
  ) {
    throw new Error("Invalid signed evidence transaction");
  }
  if (!serialized.startsWith("0x02"))
    throw new Error("Only EIP-1559 evidence transactions are supported");
  const tx = parseTransaction(serialized as `0x02${string}`);
  // viem omits canonical zero-valued RLP integers from parsed transaction fields.
  const maxPriorityFeePerGas =
    tx.type === "eip1559" ? (tx.maxPriorityFeePerGas ?? 0n) : undefined;
  const sender = await recoverTransactionAddress({
    serializedTransaction: serialized as `0x02${string}`,
  });
  const data = encodeFunctionData({
    abi: registerRootAbi,
    functionName: "registerRoot",
    args: [expected.root as Hex],
  });
  if (
    tx.type !== "eip1559" ||
    tx.chainId !== expected.chainId ||
    tx.to?.toLowerCase() !== expected.contractAddress.toLowerCase() ||
    tx.data?.toLowerCase() !== data.toLowerCase() ||
    (tx.value ?? 0n) !== 0n ||
    tx.nonce !== expected.nonce ||
    sender.toLowerCase() !== expected.signerAddress.toLowerCase() ||
    tx.gas === undefined ||
    tx.gas < 21_000n ||
    tx.gas > MAX_GAS ||
    tx.maxFeePerGas === undefined ||
    tx.maxFeePerGas <= 0n ||
    tx.maxFeePerGas > MAX_FEE ||
    maxPriorityFeePerGas === undefined ||
    maxPriorityFeePerGas < 0n ||
    maxPriorityFeePerGas > tx.maxFeePerGas ||
    !isAddress(sender)
  )
    throw new Error(
      "Signed evidence transaction does not match the authorized intent",
    );
  return {
    chainId: expected.chainId,
    contractAddress: expected.contractAddress.toLowerCase(),
    signerAddress: sender.toLowerCase(),
    root: expected.root.toLowerCase(),
    nonce: expected.nonce,
    gas: tx.gas,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas,
    transactionHash: keccak256(serialized),
    signedTransaction: serialized,
  };
}

export function createEvidenceAnchorClient(
  config: EvidenceAnchorConfig,
  transport: EvidenceAnchorTransport,
) {
  if (
    !Number.isSafeInteger(config.chainId) ||
    config.chainId <= 0 ||
    !ADDRESS.test(config.contractAddress) ||
    !ADDRESS.test(config.signerAddress)
  ) {
    throw new Error("Invalid evidence anchor configuration");
  }
  const chainId = config.chainId;
  const contractAddress = config.contractAddress.toLowerCase();
  const signerAddress = config.signerAddress.toLowerCase();

  async function verifyIdentity(): Promise<void> {
    const actualChainId = await transport.getChainId();
    if (actualChainId !== chainId) {
      throw new Error("Evidence anchor chain mismatch");
    }
    const signer = await transport.getSignerAddress();
    const contractSigner = await transport.getContractSigner(contractAddress);
    if (
      !ADDRESS.test(signer) ||
      !ADDRESS.test(contractSigner) ||
      signer.toLowerCase() !== signerAddress ||
      contractSigner.toLowerCase() !== signerAddress
    ) {
      throw new Error("Evidence anchor signer mismatch");
    }
  }

  function verifyRoot(root: string): void {
    if (!ROOT.test(root)) {
      throw new Error("Invalid evidence root");
    }
  }

  return {
    getTarget(): EvidenceAnchorTarget {
      return { chainId, contractAddress };
    },
    getSigner(): string {
      return signerAddress;
    },
    async isRootRegistered(root: string): Promise<boolean> {
      verifyRoot(root);
      await verifyIdentity();
      const registered = await transport.isRootRegistered(
        contractAddress,
        root,
      );
      if (typeof registered !== "boolean")
        throw new Error("Invalid evidence anchor lookup response");
      return registered;
    },
    async prepareRootRegistration(
      root: string,
    ): Promise<PreparedAnchorTransaction> {
      verifyRoot(root);
      await verifyIdentity();
      const nonce = await transport.getPendingNonce(signerAddress);
      if (!Number.isSafeInteger(nonce) || nonce < 0)
        throw new Error("Invalid pending signer nonce");
      const bytes = await transport.prepareRootRegistration(
        contractAddress,
        root as Hex,
        nonce,
      );
      return verifyPreparedAnchorTransaction(bytes, {
        chainId,
        contractAddress,
        signerAddress,
        root,
        nonce,
      });
    },
    async broadcastPrepared(
      prepared: PreparedAnchorTransaction,
    ): Promise<void> {
      const verified = await verifyPreparedAnchorTransaction(
        prepared.signedTransaction,
        {
          chainId,
          contractAddress,
          signerAddress,
          root: prepared.root,
          nonce: prepared.nonce,
        },
      );
      if (verified.transactionHash !== prepared.transactionHash)
        throw new Error("Prepared hash mismatch");
      const returned = await transport.broadcastSignedTransaction(
        prepared.signedTransaction,
      );
      if (returned.toLowerCase() !== verified.transactionHash.toLowerCase()) {
        throw new Error("Evidence broadcast hash mismatch; outcome unknown");
      }
    },
  };
}
import {
  encodeFunctionData,
  isAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
} from "viem";
