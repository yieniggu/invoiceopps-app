import {
  createPublicClient,
  custom,
  type Hex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from "viem";

// Mirrors EvidenceRootAnchor.sol: both event arguments are indexed.
export const rootRegisteredAbi = [
  {
    type: "event",
    name: "RootRegistered",
    inputs: [
      { name: "rootHash", type: "bytes32", indexed: true },
      { name: "signer", type: "address", indexed: true },
    ],
  },
] as const;

const signerAbi = [
  {
    type: "function",
    name: "signer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

const allowed = new Set([
  "eth_chainId",
  "eth_call",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockByNumber",
]);

export function createViemEvidenceAnchorReader(provider: {
  request(args: {
    method: string;
    params?: readonly unknown[];
  }): Promise<unknown>;
}) {
  const client = createPublicClient({
    transport: custom(
      {
        async request(args) {
          if (!allowed.has(args.method))
            throw new Error("Read-only evidence RPC method denied");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              provider.request(args),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Evidence RPC timed out")),
                  10_000,
                );
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
      },
      { retryCount: 0 },
    ),
  });
  return {
    getChainId: () => client.getChainId(),
    getContractSigner: (address: string) =>
      client.readContract({
        address: address as Hex,
        abi: signerAbi,
        functionName: "signer",
      }),
    async getTransaction(hash: string) {
      try {
        return await client.getTransaction({ hash: hash as Hex });
      } catch (error) {
        if (error instanceof TransactionNotFoundError) return null;
        throw error;
      }
    },
    async getReceipt(hash: string) {
      try {
        return await client.getTransactionReceipt({ hash: hash as Hex });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
    getCanonicalBlock: (number: bigint) =>
      client.getBlock({ blockNumber: number }),
  };
}
