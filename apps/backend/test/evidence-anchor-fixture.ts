import { encodeFunctionData, keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { vi } from "vitest";

import { registerRootAbi } from "../src/evidence-anchor-client.js";

const account = privateKeyToAccount(generatePrivateKey());
export const fixtureSigner = account.address.toLowerCase();

export function signedAnchorTransport(root: string, contractAddress: string) {
  const data = encodeFunctionData({
    abi: registerRootAbi,
    functionName: "registerRoot",
    args: [root as Hex],
  });
  return {
    getPendingNonce: vi.fn(async () => 7),
    prepareRootRegistration: vi.fn(async () =>
      account.signTransaction({
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
    ),
    broadcastSignedTransaction: vi.fn(async (bytes: Hex) => keccak256(bytes)),
  };
}

export function durablePreparationPorts() {
  return {
    acquireSignerPreparationSlot: vi.fn(async () => {}),
    persistPreparedTransaction: vi.fn(async () => {}),
  };
}
