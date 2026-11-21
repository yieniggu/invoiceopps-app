import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_RESPONSE_BYTES,
  requestJson,
  ServiceUnreachableError,
} from "../../src/features/models/http-json.js";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  const closing = new Promise((resolve) => server!.close(resolve));
  server.closeAllConnections();
  await closing;
  server = undefined;
});

async function serve(
  handler: Parameters<typeof createServer>[1],
): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) =>
    server!.listen(0, "127.0.0.1", () => resolve()),
  );
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const get = (url: string, maxResponseBytes?: number) =>
  requestJson("model-api", url, {
    method: "GET",
    headers: {},
    timeoutMs: 2_000,
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  });

describe("http-json response size cap", () => {
  it("has a 1 MiB default", () => {
    expect(MAX_RESPONSE_BYTES).toBe(1024 * 1024);
  });

  it("reads a body under the cap", async () => {
    const url = await serve((_request, response) => {
      response.end(JSON.stringify({ ok: true }));
    });
    expect(await get(url, 1024)).toEqual({ status: 200, body: { ok: true } });
  });

  it("fails as unreachable (response) when Content-Length exceeds the cap", async () => {
    const url = await serve((_request, response) => {
      response.end(JSON.stringify({ blob: "x".repeat(5_000) }));
    });
    await expect(get(url, 1024)).rejects.toMatchObject({
      constructor: ServiceUnreachableError,
      kind: "response",
    });
  });

  it("fails when a chunked body without Content-Length grows past the cap", async () => {
    const url = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"blob":"');
      for (let index = 0; index < 20; index += 1) {
        response.write("x".repeat(500));
      }
      response.end('"}');
    });
    await expect(get(url, 1024)).rejects.toMatchObject({
      kind: "response",
    });
  });

  it("reports a refused connection as connection and a slow answer as timeout", async () => {
    await expect(get("http://127.0.0.1:1")).rejects.toMatchObject({
      kind: "connection",
    });
    const url = await serve(() => {
      // never answers
    });
    await expect(
      requestJson("model-api", url, {
        method: "GET",
        headers: {},
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});
