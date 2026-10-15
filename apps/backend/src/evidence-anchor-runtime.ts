import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import { createPublicClient, custom, type Hex } from "viem";

import type {
  EvidenceAnchorAction,
  EvidenceAnchorConfig,
} from "./evidence-anchor-config.js";
import { createViemEvidenceAnchorReader } from "./evidence-anchor-reconciliation-viem.js";
import { createViemEvidenceAnchorTransport } from "./evidence-anchor-viem.js";
import type { EvidenceAnchorTransport } from "./evidence-anchor-client.js";
import type { ChainReader } from "./evidence-anchor-reconciliation.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const ALLOWED = {
  anchor: new Set([
    "eth_chainId",
    "eth_call",
    "eth_getTransactionCount",
    "eth_estimateGas",
    "eth_maxPriorityFeePerGas",
    "eth_feeHistory",
    "eth_gasPrice",
    "eth_getBlockByNumber",
    "eth_sendRawTransaction",
  ]),
  reconcile: new Set([
    "eth_chainId",
    "eth_call",
    "eth_getTransactionByHash",
    "eth_getTransactionReceipt",
    "eth_getBlockByNumber",
  ]),
};

export interface EvidenceRpcProvider {
  request(args: {
    method: string;
    params?: readonly unknown[];
  }): Promise<unknown>;
}

export function createEvidenceAnchorHttpProvider(
  endpoint: string,
  action: EvidenceAnchorAction,
): EvidenceRpcProvider {
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    )
  )
    throw new Error("Evidence RPC endpoint rejected");
  return {
    async request({ method, params = [] }) {
      if (!ALLOWED[action].has(method))
        throw new Error("Evidence RPC method denied");
      const id = randomUUID();
      const body = Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      );
      if (body.length > MAX_RESPONSE_BYTES)
        throw new Error("Evidence RPC request too large");
      return new Promise((resolve, reject) => {
        const transport =
          url.protocol === "https:" ? httpsRequest : httpRequest;
        let settled = false;
        let responseEnded = false;
        let req: ReturnType<typeof httpRequest>;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const settle = (error?: Error, value?: unknown) => {
          if (settled) return;
          settled = true;
          if (deadline) clearTimeout(deadline);
          if (error) reject(error);
          else resolve(value);
        };
        const failStream = () => {
          if (settled) return;
          settle(new Error("Evidence RPC request failed"));
          req.destroy();
        };
        try {
          req = transport(
            url,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "content-length": body.length,
              },
              timeout: 10_000,
            },
            (response) => {
              response.on("error", failStream);
              response.on("aborted", failStream);
              response.on("close", () => {
                if (!responseEnded) failStream();
              });
              if (response.statusCode !== 200) {
                failStream();
                return;
              }
              const chunks: Buffer[] = [];
              let size = 0;
              response.on("data", (chunk: Buffer) => {
                if (settled) return;
                size += chunk.length;
                if (size > MAX_RESPONSE_BYTES) {
                  failStream();
                  return;
                }
                chunks.push(chunk);
              });
              response.on("end", () => {
                responseEnded = true;
                if (settled) return;
                try {
                  const parsed = JSON.parse(
                    Buffer.concat(chunks).toString("utf8"),
                  ) as {
                    jsonrpc?: unknown;
                    id?: unknown;
                    result?: unknown;
                    error?: { code?: unknown; message?: unknown };
                  };
                  if (
                    parsed.jsonrpc !== "2.0" ||
                    parsed.id !== id ||
                    "result" in parsed === "error" in parsed
                  )
                    throw new Error("invalid");
                  if ("error" in parsed) {
                    if (
                      !parsed.error ||
                      typeof parsed.error !== "object" ||
                      !Number.isInteger(parsed.error.code) ||
                      typeof parsed.error.message !== "string"
                    )
                      throw new Error("invalid");
                    const failure = new Error("Evidence RPC returned an error");
                    Object.defineProperty(failure, "code", {
                      value: parsed.error.code,
                    });
                    throw failure;
                  }
                  settle(undefined, parsed.result);
                } catch {
                  settle(new Error("Evidence RPC response invalid"));
                }
              });
            },
          );
          req.on("timeout", () => {
            settle(new Error("Evidence RPC request failed"));
            req.destroy();
          });
          req.on("error", () =>
            settle(new Error("Evidence RPC request failed")),
          );
          deadline = setTimeout(() => {
            settle(new Error("Evidence RPC request failed"));
            req.destroy();
          }, 10_000);
          req.end(body);
        } catch {
          settle(new Error("Evidence RPC request failed"));
        }
      });
    },
  };
}

export function createEvidenceAnchorRuntime(
  config: Extract<EvidenceAnchorConfig, { kind: "configured" }>,
  action: EvidenceAnchorAction,
  provider: EvidenceRpcProvider = createEvidenceAnchorHttpProvider(
    config.target.rpcUrl,
    action,
  ),
): { transport: EvidenceAnchorTransport; chainReader: ChainReader } {
  const publicClient = createPublicClient({
    transport: custom(
      {
        request(args) {
          if (!ALLOWED[action].has(args.method))
            throw new Error("Evidence RPC method denied");
          return provider.request(args);
        },
      },
      { retryCount: 0 },
    ),
  });
  const reader = createViemEvidenceAnchorReader(provider);
  const readTransport = {
    async getChainId() {
      return publicClient.getChainId();
    },
    async getSignerAddress() {
      if (action !== "anchor" || !config.signerAddress)
        throw new Error("Evidence signer unavailable");
      return config.signerAddress;
    },
    getContractSigner(address: string) {
      return reader.getContractSigner(address);
    },
    async isRootRegistered(address: string, root: string) {
      return publicClient.readContract({
        address: address as Hex,
        abi: [
          {
            type: "function",
            name: "isRootRegistered",
            stateMutability: "view",
            inputs: [{ name: "root", type: "bytes32" }],
            outputs: [{ type: "bool" }],
          },
        ],
        functionName: "isRootRegistered",
        args: [root as Hex],
      });
    },
    async getPendingNonce(address: string) {
      if (action !== "anchor" || !config.getAccount)
        throw new Error("Evidence signer unavailable");
      return publicClient.getTransactionCount({
        address: address as Hex,
        blockTag: "pending",
      });
    },
    async prepareRootRegistration(address: string, root: Hex, nonce: number) {
      if (action !== "anchor" || !config.getAccount)
        throw new Error("Evidence signer unavailable");
      return createViemEvidenceAnchorTransport(
        config.target.chainId,
        config.getAccount(),
        provider,
      ).prepareRootRegistration(address, root, nonce);
    },
    async broadcastSignedTransaction(transaction: Hex) {
      if (action !== "anchor") throw new Error("Evidence write method denied");
      return createViemEvidenceAnchorTransport(
        config.target.chainId,
        config.getAccount!(),
        provider,
      ).broadcastSignedTransaction(transaction);
    },
  } satisfies EvidenceAnchorTransport;
  return { transport: readTransport, chainReader: reader };
}
