import { describe, expect, it, vi } from "vitest";

import { createOwnedAnvilRpc } from "./owned-anvil-rpc.mjs";

describe("owned Anvil RPC request correlation without a network", () => {
  it("accepts concurrent out-of-order replies by each captured request ID", async () => {
    const pending: Array<{ id: number; resolve(response: Response): void }> =
      [];
    const assertOwner = vi.fn<(pid: number, port: number) => void>();
    const fetchResponse: typeof fetch = async (input, init) => {
      expect(input).toBe("http://127.0.0.1:45678/");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (typeof init?.body !== "string")
        throw new Error("Expected in-memory JSON request body");
      const body: unknown = JSON.parse(init.body);
      if (
        typeof body !== "object" ||
        body === null ||
        !("id" in body) ||
        !("jsonrpc" in body) ||
        typeof body.id !== "number"
      )
        throw new Error("Expected JSON-RPC request ID");
      const id = body.id;
      expect(body.jsonrpc).toBe("2.0");
      return new Promise<Response>((resolve) => pending.push({ id, resolve }));
    };
    const rpc = createOwnedAnvilRpc({
      pid: 123,
      port: 45678,
      assertOwner,
      fetchResponse,
    });
    const first = rpc.request("eth_chainId");
    const second = rpc.request("eth_blockNumber");
    expect(pending.map(({ id }) => id)).toEqual([1, 2]);
    expect(assertOwner).toHaveBeenCalledTimes(2);
    expect(assertOwner).toHaveBeenNthCalledWith(1, 123, 45678);
    pending[1].resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "0x02" })),
    );
    expect(await second).toBe("0x02");
    pending[0].resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x01" })),
    );
    expect(await first).toBe("0x01");
    expect(rpc.getRequestCount()).toBe(2);
    expect(rpc.getLastMethod()).toBe("eth_blockNumber");
  });

  it("rejects a mismatched response without retry or another fetch", async () => {
    const fetchResponse = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 999, result: "0x01" }),
        ),
    );
    const rpc = createOwnedAnvilRpc({
      pid: 123,
      port: 45678,
      assertOwner: () => {},
      fetchResponse,
    });
    await expect(rpc.request("eth_chainId")).rejects.toThrow(
      "Invalid owned RPC response",
    );
    expect(fetchResponse).toHaveBeenCalledTimes(1);
  });
});
