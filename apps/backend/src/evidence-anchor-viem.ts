import {
  createPublicClient,
  custom,
  encodeFunctionData,
  type Hex,
  type LocalAccount,
} from "viem";

import {
  registerRootAbi,
  type EvidenceAnchorTransport,
} from "./evidence-anchor-client.js";

// The provider is injected. This factory does not create a network connection or load keys.
export function createViemEvidenceAnchorTransport(
  chainId: number,
  account: LocalAccount,
  provider: {
    request(args: {
      method: string;
      params?: readonly unknown[];
    }): Promise<unknown>;
  },
): Pick<
  EvidenceAnchorTransport,
  "getPendingNonce" | "prepareRootRegistration" | "broadcastSignedTransaction"
> {
  const boundedProvider = {
    async request(args: { method: string; params?: readonly unknown[] }) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          provider.request(args),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error("Evidence RPC timed out; outcome unknown")),
              10_000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
  const client = createPublicClient({
    transport: custom(boundedProvider, { retryCount: 0 }),
  });
  return {
    async getPendingNonce(signerAddress) {
      const nonce = await client.getTransactionCount({
        address: signerAddress as Hex,
        blockTag: "pending",
      });
      if (!Number.isSafeInteger(nonce) || nonce < 0)
        throw new Error("Invalid pending nonce");
      return nonce;
    },
    async prepareRootRegistration(contractAddress, root, nonce) {
      const data = encodeFunctionData({
        abi: registerRootAbi,
        functionName: "registerRoot",
        args: [root],
      });
      const [gas, fees] = await Promise.all([
        client.estimateGas({
          account: account.address,
          to: contractAddress as Hex,
          data,
          value: 0n,
        }),
        client.estimateFeesPerGas({ type: "eip1559", chain: null }),
      ]);
      if (
        gas < 21_000n ||
        gas > 3_000_000n ||
        fees.maxFeePerGas === undefined ||
        fees.maxPriorityFeePerGas === undefined ||
        fees.maxFeePerGas <= 0n ||
        fees.maxFeePerGas > 1_000_000_000_000n ||
        fees.maxPriorityFeePerGas < 0n ||
        fees.maxPriorityFeePerGas > fees.maxFeePerGas
      )
        throw new Error("Invalid evidence gas or fee estimate");
      return account.signTransaction({
        type: "eip1559",
        chainId,
        nonce,
        to: contractAddress as Hex,
        data,
        value: 0n,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
    },
    async broadcastSignedTransaction(signedTransaction) {
      return client.sendRawTransaction({
        serializedTransaction: signedTransaction,
      });
    },
  };
}
