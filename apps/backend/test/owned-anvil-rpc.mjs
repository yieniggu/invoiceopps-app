// The injected fetch and ownership check make this transport testable without a node.
export function createOwnedAnvilRpc({ pid, port, assertOwner, fetchResponse }) {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    port > 65535 ||
    typeof assertOwner !== "function" ||
    typeof fetchResponse !== "function"
  )
    throw new Error("Invalid owned RPC transport configuration");
  const endpoint = `http://127.0.0.1:${port}/`;
  let requestCount = 0;
  let lastMethod = "none";
  return {
    getRequestCount: () => requestCount,
    getLastMethod: () => lastMethod,
    async request(method, params = []) {
      assertOwner(pid, port);
      const requestId = ++requestCount;
      lastMethod = method;
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params,
      });
      if (payload.length > 100_000)
        throw new Error("RPC request exceeds smoke budget");
      const response = await fetchResponse(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (
        response.status !== 200 ||
        Number(response.headers.get("content-length") ?? 0) > 256_000
      )
        throw new Error("Invalid owned RPC response status or size");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Owned RPC response body unavailable");
      const parts = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256_000) {
          await reader.cancel();
          throw new Error("Owned RPC response exceeds smoke budget");
        }
        parts.push(value);
      }
      const body = Buffer.concat(parts).toString("utf8");
      if (body.length > 256_000)
        throw new Error("Owned RPC response exceeds smoke budget");
      const decoded = JSON.parse(body);
      if (
        decoded.jsonrpc !== "2.0" ||
        decoded.id !== requestId ||
        decoded.error ||
        decoded.result === undefined
      )
        throw new Error("Invalid owned RPC response");
      return decoded.result;
    },
  };
}
