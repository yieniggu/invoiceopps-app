import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
} from "viem";

import { registerRootAbi } from "../src/evidence-anchor-client.js";
import {
  createViemEvidenceAnchorReader,
  rootRegisteredAbi,
} from "../src/evidence-anchor-reconciliation-viem.js";

const hash = `0x${"ab".repeat(32)}` as Hex;
const blockHash = `0x${"cd".repeat(32)}` as Hex;
const root = `0x${"ef".repeat(32)}` as Hex;
const signer = `0x${"11".repeat(20)}` as Hex;
const contract = `0x${"22".repeat(20)}` as Hex;

describe("TX06 viem read-only RPC boundary", () => {
  it("decodes actual SDK transaction, receipt, signer and canonical number requests without write methods", async () => {
    const methods: string[] = [];
    const reader = createViemEvidenceAnchorReader({
      async request({ method, params }) {
        methods.push(method);
        if (method === "eth_chainId") return "0x7a69";
        if (method === "eth_call") {
          expect(params?.[0]).toMatchObject({ to: contract });
          return encodeAbiParameters([{ type: "address" }], [signer]);
        }
        if (method === "eth_getTransactionByHash") {
          expect(params).toEqual([hash]);
          return {
            hash,
            from: signer,
            to: contract,
            chainId: "0x7a69",
            type: "0x2",
            nonce: "0x7",
            gas: "0x15f90",
            maxFeePerGas: "0x77359400",
            maxPriorityFeePerGas: "0x3b9aca00",
            value: "0x0",
            input: encodeFunctionData({
              abi: registerRootAbi,
              functionName: "registerRoot",
              args: [root],
            }),
            blockHash,
            blockNumber: "0x4",
            transactionIndex: "0x0",
            v: "0x0",
            r: hash,
            s: hash,
          };
        }
        if (method === "eth_getTransactionReceipt") {
          expect(params).toEqual([hash]);
          return {
            transactionHash: hash,
            from: signer,
            to: contract,
            status: "0x1",
            blockHash,
            blockNumber: "0x4",
            transactionIndex: "0x0",
            cumulativeGasUsed: "0x15f90",
            gasUsed: "0x15f90",
            effectiveGasPrice: "0x77359400",
            logsBloom: `0x${"00".repeat(256)}`,
            type: "0x2",
            logs: [
              {
                address: contract,
                topics: encodeEventTopics({
                  abi: rootRegisteredAbi,
                  eventName: "RootRegistered",
                  args: { rootHash: root, signer },
                }),
                data: "0x",
                blockHash,
                blockNumber: "0x4",
                transactionHash: hash,
                transactionIndex: "0x0",
                logIndex: "0x0",
                removed: false,
              },
            ],
          };
        }
        if (method === "eth_getBlockByNumber") {
          expect(params?.[0]).toBe("0x4");
          return {
            number: "0x4",
            hash: blockHash,
            parentHash: hash,
            nonce: "0x0000000000000000",
            sha3Uncles: hash,
            logsBloom: `0x${"00".repeat(256)}`,
            transactionsRoot: hash,
            stateRoot: hash,
            receiptsRoot: hash,
            miner: signer,
            difficulty: "0x0",
            totalDifficulty: "0x0",
            extraData: "0x",
            size: "0x1",
            gasLimit: "0x1c9c380",
            gasUsed: "0x15f90",
            timestamp: "0x1",
            transactions: [],
            uncles: [],
            mixHash: hash,
          };
        }
        throw new Error("Forbidden RPC method");
      },
    });
    expect(await reader.getChainId()).toBe(31337);
    expect(await reader.getContractSigner(contract)).toBe(signer);
    expect((await reader.getTransaction(hash))?.hash).toBe(hash);
    expect((await reader.getReceipt(hash))?.status).toBe("success");
    expect((await reader.getCanonicalBlock(4n)).hash).toBe(blockHash);
    expect(methods).toEqual([
      "eth_chainId",
      "eth_call",
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
      "eth_getBlockByNumber",
    ]);
  });

  it("distinguishes not-found from provider failure", async () => {
    const reader = createViemEvidenceAnchorReader({
      async request({ method }) {
        if (
          method === "eth_getTransactionByHash" ||
          method === "eth_getTransactionReceipt"
        )
          return null;
        throw new Error("private provider response");
      },
    });
    await expect(reader.getTransaction(hash)).resolves.toBeNull();
    await expect(reader.getReceipt(hash)).resolves.toBeNull();
    await expect(reader.getChainId()).rejects.toThrow();
  });
});
