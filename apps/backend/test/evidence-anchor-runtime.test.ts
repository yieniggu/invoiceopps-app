import { EventEmitter } from "node:events";
import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { readEvidenceAnchorConfig } from "../src/evidence-anchor-config.js";
import { createEvidenceAnchorClient } from "../src/evidence-anchor-client.js";
import {
  createEvidenceAnchorHttpProvider,
  createEvidenceAnchorRuntime,
} from "../src/evidence-anchor-runtime.js";
import type { EvidenceRpcProvider } from "../src/evidence-anchor-runtime.js";

const mockedHttp = vi.hoisted(() => ({ request: vi.fn() }));
const mockedHttps = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  mockedHttp.request.mockImplementation(actual.request);
  return { ...actual, request: mockedHttp.request };
});
vi.mock("node:https", () => ({ request: mockedHttps.request }));

const CONTRACT = `0x${"11".repeat(20)}`;
const ROOT = `0x${"aa".repeat(32)}` as Hex;

describe("evidence anchor runtime", () => {
  it("allows the Compose Anvil endpoint only with the validated STACK-08 capability", () => {
    expect(() =>
      createEvidenceAnchorHttpProvider("http://anvil:8545", "anchor"),
    ).toThrow("Evidence RPC endpoint rejected");
    expect(() =>
      createEvidenceAnchorHttpProvider("http://anvil:8545", "anchor", true),
    ).not.toThrow();
  });

  it("settles response emitter errors once and retains request error handling through destroy", async () => {
    const request = new EventEmitter() as EventEmitter & {
      destroy(): void;
      end(body: Buffer): void;
    };
    const response = new EventEmitter() as EventEmitter & {
      statusCode: number;
      resume(): void;
    };
    type RpcResponse = typeof response;
    response.statusCode = 200;
    response.resume = () => {};
    request.end = () => {};
    request.destroy = () => {
      queueMicrotask(() =>
        request.emit("error", new Error("synthetic request detail")),
      );
    };
    mockedHttp.request.mockImplementationOnce(
      (
        _url: URL,
        _options: unknown,
        callback: (response: RpcResponse) => void,
      ) => {
        queueMicrotask(() => {
          callback(response);
          response.emit("error", new Error("synthetic response detail"));
          response.emit("error", new Error("late response detail"));
        });
        return request;
      },
    );

    await expect(
      createEvidenceAnchorHttpProvider(
        "http://127.0.0.1:1",
        "reconcile",
      ).request({ method: "eth_chainId" }),
    ).rejects.toThrow("Evidence RPC request failed");
    expect(request.listenerCount("error")).toBe(1);
    expect(response.listenerCount("error")).toBe(1);
  });

  it("destroys a non-200 request and ignores late response errors and close", async () => {
    const request = new EventEmitter() as EventEmitter & {
      destroy(): void;
      end(body: Buffer): void;
    };
    const response = new EventEmitter() as EventEmitter & {
      statusCode: number;
      resume(): void;
    };
    type RpcResponse = typeof response;
    response.statusCode = 503;
    response.resume = () => {};
    request.end = () => {};
    const destroy = vi.fn(() => {
      queueMicrotask(() =>
        request.emit("error", new Error("late request detail")),
      );
    });
    request.destroy = destroy;
    mockedHttp.request.mockImplementationOnce(
      (
        _url: URL,
        _options: unknown,
        callback: (response: RpcResponse) => void,
      ) => {
        queueMicrotask(() => callback(response));
        return request;
      },
    );

    await expect(
      createEvidenceAnchorHttpProvider(
        "http://127.0.0.1:1",
        "reconcile",
      ).request({ method: "eth_chainId" }),
    ).rejects.toThrow("Evidence RPC request failed");
    response.emit("error", new Error("late response detail"));
    response.emit("close");
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(request.listenerCount("error")).toBe(1);
    expect(response.listenerCount("error")).toBe(1);
  });

  it("settles truncated HTTP responses safely and rejects malformed JSON-RPC envelopes", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-length": "128" });
      response.write('{"jsonrpc":"2.0","id":"partial"');
      response.destroy();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected loopback listener");
    try {
      const provider = createEvidenceAnchorHttpProvider(
        `http://127.0.0.1:${address.port}`,
        "reconcile",
      );
      await expect(provider.request({ method: "eth_chainId" })).rejects.toThrow(
        "Evidence RPC request failed",
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects JSON-RPC response envelopes with mismatched version or result/error fields", async () => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: string;
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "1.0",
          id: payload.id,
          result: "0x7a69",
          error: { code: -1, message: "sensitive provider detail" },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected loopback listener");
    try {
      const provider = createEvidenceAnchorHttpProvider(
        `http://127.0.0.1:${address.port}`,
        "reconcile",
      );
      await expect(provider.request({ method: "eth_chainId" })).rejects.toThrow(
        "Evidence RPC response invalid",
      );
      await expect(
        provider.request({ method: "eth_chainId" }),
      ).rejects.not.toThrow("sensitive provider detail");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("rejects mismatched response IDs without exposing response fields", async () => {
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: string;
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: `${payload.id}-mismatch`,
          result: "synthetic-response-value",
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected loopback listener");
    try {
      const provider = createEvidenceAnchorHttpProvider(
        `http://127.0.0.1:${address.port}`,
        "reconcile",
      );
      let failure: unknown;
      try {
        await provider.request({ method: "eth_chainId" });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("Evidence RPC response invalid");
      expect(String(failure)).not.toContain("synthetic-response-value");
      expect(String(failure)).not.toContain("mismatch");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not expose non-200 response bodies or provider details", async () => {
    let connectionClosed = false;
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      const drip = setInterval(() => response.write("x"), 10);
      response.on("close", () => {
        connectionClosed = true;
        clearInterval(drip);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected loopback listener");
    try {
      const provider = createEvidenceAnchorHttpProvider(
        `http://127.0.0.1:${address.port}`,
        "reconcile",
      );
      let failure: unknown;
      try {
        await provider.request({ method: "eth_chainId" });
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain("Evidence RPC request failed");
      expect(String(failure)).not.toContain("synthetic-provider-body-secret");
      await vi.waitFor(() => expect(connectionClosed).toBe(true), {
        timeout: 1_000,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("uses an injected bounded read provider and never needs a signer for reconciliation", async () => {
    const config = readEvidenceAnchorConfig(
      {
        EVM_RPC_URL: "https://rpc.example.invalid/path?synthetic=secret",
        EVM_CHAIN_ID: "31337",
        EVIDENCE_CONTRACT_ADDRESS: CONTRACT,
      },
      "reconcile",
    );
    if (config.kind !== "configured") throw new Error("Expected config");
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x7a69";
      throw new Error("Unexpected provider method");
    });
    const runtime = createEvidenceAnchorRuntime(config, "reconcile", {
      request,
    } as EvidenceRpcProvider);

    await expect(runtime.chainReader.getChainId()).resolves.toBe(31337);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "eth_chainId" }),
    );
    await expect(runtime.transport.getSignerAddress()).rejects.toThrow(
      "Evidence signer unavailable",
    );
    expect(JSON.stringify(config)).not.toContain("synthetic=secret");
    expect(JSON.stringify(config)).not.toContain("EVM_SIGNER_PRIVATE_KEY");
  });

  it("rejects write methods through reconciliation before invoking the provider", async () => {
    const config = readEvidenceAnchorConfig(
      {
        EVM_RPC_URL: "https://rpc.example.invalid",
        EVM_CHAIN_ID: "31337",
        EVIDENCE_CONTRACT_ADDRESS: CONTRACT,
      },
      "reconcile",
    );
    if (config.kind !== "configured") throw new Error("Expected config");
    const request = vi.fn(async () => "0x");
    const runtime = createEvidenceAnchorRuntime(config, "reconcile", {
      request,
    } as EvidenceRpcProvider);

    await expect(
      runtime.transport.broadcastSignedTransaction(`0x${"11".repeat(32)}`),
    ).rejects.toThrow("Evidence write method denied");
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps account derivation in the configured anchor closure", () => {
    const key = generatePrivateKey();
    const config = readEvidenceAnchorConfig(
      {
        EVM_RPC_URL: "https://rpc.example.invalid",
        EVM_CHAIN_ID: "31337",
        EVIDENCE_CONTRACT_ADDRESS: CONTRACT,
        EVM_SIGNER_PRIVATE_KEY: key,
      },
      "anchor",
    );
    expect(JSON.stringify(config)).not.toContain(key);
    if (config.kind !== "configured") throw new Error("Expected config");
    expect(config.getAccount?.().address).toBe(config.signerAddress);
  });

  it("prepares and locally verifies a signed transaction through the default HTTP allowlist", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const config = readEvidenceAnchorConfig(
      {
        EVM_RPC_URL: "https://rpc.example.invalid",
        EVM_CHAIN_ID: "31337",
        EVIDENCE_CONTRACT_ADDRESS: CONTRACT,
        EVM_SIGNER_PRIVATE_KEY: privateKey,
      },
      "anchor",
    );
    if (config.kind !== "configured") throw new Error("Expected config");
    if (!config.signerAddress) throw new Error("Expected signer address");
    const methods: string[] = [];
    mockedHttps.request.mockImplementation(
      (
        _url: URL,
        _options: unknown,
        callback: (
          response: EventEmitter & { statusCode: number; resume(): void },
        ) => void,
      ) => {
        const request = new EventEmitter() as EventEmitter & {
          end(body: Buffer): void;
          destroy(error?: Error): void;
        };
        request.end = (body) => {
          const rpc = JSON.parse(body.toString("utf8")) as {
            id: string;
            method: string;
          };
          methods.push(rpc.method);
          const results: Record<string, unknown> = {
            eth_chainId: "0x7a69",
            eth_call: `0x${"0".repeat(24)}${account.address.slice(2).toLowerCase()}`,
            eth_getTransactionCount: "0x7",
            eth_estimateGas: "0x15f90",
            eth_getBlockByNumber: {
              number: "0x1",
              hash: `0x${"01".repeat(32)}`,
              parentHash: `0x${"02".repeat(32)}`,
              nonce: "0x0000000000000000",
              sha3Uncles: `0x${"03".repeat(32)}`,
              logsBloom: `0x${"00".repeat(256)}`,
              transactionsRoot: `0x${"04".repeat(32)}`,
              stateRoot: `0x${"05".repeat(32)}`,
              receiptsRoot: `0x${"06".repeat(32)}`,
              miner: `0x${"00".repeat(20)}`,
              difficulty: "0x0",
              totalDifficulty: "0x0",
              extraData: "0x",
              size: "0x1",
              gasLimit: "0x1c9c380",
              gasUsed: "0x0",
              timestamp: "0x1",
              transactions: [],
              uncles: [],
              baseFeePerGas: "0x3b9aca00",
            },
            eth_maxPriorityFeePerGas: "0x3b9aca00",
            eth_feeHistory: {
              oldestBlock: "0x1",
              baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"],
              gasUsedRatio: [0],
              reward: [["0x3b9aca00"]],
            },
            eth_gasPrice: "0x77359400",
          };
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            resume(): void;
          };
          response.statusCode = 200;
          response.resume = () => {};
          callback(response);
          queueMicrotask(() => {
            response.emit(
              "data",
              Buffer.from(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: rpc.id,
                  result: results[rpc.method] ?? null,
                }),
              ),
            );
            response.emit("end");
          });
        };
        request.destroy = (error) => {
          if (error) request.emit("error", error);
        };
        return request;
      },
    );
    const runtime = createEvidenceAnchorRuntime(config, "anchor");
    const client = createEvidenceAnchorClient(
      {
        chainId: config.target.chainId,
        contractAddress: config.target.contractAddress,
        signerAddress: config.signerAddress,
      },
      runtime.transport,
    );

    const prepared = await client.prepareRootRegistration(ROOT);

    expect(prepared.signedTransaction).toMatch(/^0x02/);
    expect(prepared.signerAddress.toLowerCase()).toBe(
      account.address.toLowerCase(),
    );
    expect(methods).toContain("eth_getBlockByNumber");
    expect(methods).toEqual(
      expect.arrayContaining([
        "eth_chainId",
        "eth_call",
        "eth_getTransactionCount",
        "eth_estimateGas",
        "eth_getBlockByNumber",
      ]),
    );
    expect(methods).not.toContain("eth_sendTransaction");
    expect(methods).not.toContain("personal_unlockAccount");
  });
});
