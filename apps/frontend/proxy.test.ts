// @vitest-environment node
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { createServer, type ProxyOptions, type ViteDevServer } from "vite";
import { describe, expect, it } from "vitest";
import config from "./vite.config";

const route = "/platform/organizations";
function discoveryRule(): [string, ProxyOptions] {
  const rules = Object.entries(config.server?.proxy ?? {});
  const match = rules.find(([key]) =>
    key.startsWith("^") ? new RegExp(key).test(route) : route.startsWith(key),
  );
  expect(
    match,
    "Discovery must be proxied, not served by SPA fallback",
  ).toBeDefined();
  if (!match || typeof match[1] === "string")
    throw new Error("Expected explicit bounded proxy options");
  return [match[0], match[1]];
}

describe("CR-002 exact discovery transport", () => {
  it("bounds Vite discovery to the registered surface and preserves target/headers/path", () => {
    const [key, options] = discoveryRule();
    expect(key.startsWith("^")).toBe(true);
    const pattern = new RegExp(key);
    expect(pattern.test(`${route}?limit=2`)).toBe(true);
    for (const path of [
      "/platform/other",
      `${route}/org-1/members`,
      `${route}-extra`,
      "/business-policies",
    ])
      expect(pattern.test(path)).toBe(false);
    expect(options.target).toBe("http://localhost:3000");
    expect(options.changeOrigin).toBe(false);
    expect(options.xfwd).toBe(true);
    expect(options.rewrite).toBeUndefined();
  });

  it("routes Nginx discovery exactly before SPA fallback without URI rewriting", () => {
    const source = readFileSync(
      new URL("./nginx.conf", import.meta.url),
      "utf8",
    );
    const block = source.match(
      /location\s+=\s+\/platform\/organizations\s*\{([^}]+)\}/,
    );
    expect(
      block,
      "Exact discovery location must prevent SPA fallthrough",
    ).not.toBeNull();
    expect(block?.[1]).toContain("proxy_pass http://backend:3000;");
    expect(block?.[1]).toContain("proxy_set_header Host $http_host;");
    expect(block?.[1]).toContain(
      "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    );
    expect(block?.[1]).toContain("proxy_set_header X-Forwarded-Proto $scheme;");
    expect(block?.[1]).not.toMatch(/rewrite|try_files/);
    expect(source).not.toMatch(/location\s+(?:\^~\s+)?\/platform\//);
    expect(source).toContain("try_files $uri $uri/ /index.html;");
  });

  it("forwards actual Vite HTTP to an owned loopback backend, retaining query and forwarding headers", async () => {
    const [key, options] = discoveryRule();
    const requests: string[] = [];
    const backend = createHttpServer((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ path: request.url, headers: request.headers }),
      );
    });
    let vite: ViteDevServer | undefined;
    try {
      backend.listen(0, "127.0.0.1");
      await once(backend, "listening");
      const address = backend.address();
      if (!address || typeof address === "string")
        throw new Error("Missing backend port");
      vite = await createServer({
        configFile: false,
        envDir: false,
        root: import.meta.dirname,
        plugins: [],
        logLevel: "silent",
        optimizeDeps: { noDiscovery: true, include: [] },
        server: {
          host: "127.0.0.1",
          port: 0,
          hmr: false,
          watch: null,
          proxy: {
            [key]: { ...options, target: `http://127.0.0.1:${address.port}` },
          },
        },
      });
      await vite.listen();
      const frontend = vite.httpServer?.address();
      if (!frontend || typeof frontend === "string")
        throw new Error("Missing frontend port");
      const origin = `http://127.0.0.1:${frontend.port}`;
      const response = await fetch(`${origin}${route}?name=A%20B&limit=2`, {
        headers: { "X-Forwarded-For": "192.0.2.10" },
        signal: AbortSignal.timeout(2000),
      });
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      const body = (await response.json()) as {
        path: string;
        headers: Record<string, string>;
      };
      expect(body.path).toBe(`${route}?name=A%20B&limit=2`);
      expect(body.headers.host).toBe(`127.0.0.1:${frontend.port}`);
      expect(body.headers["x-forwarded-proto"]).toBe("http");
      expect(body.headers["x-forwarded-for"]).toBe("192.0.2.10,127.0.0.1");
      const unrelated = await fetch(`${origin}/platform/unrelated`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(2000),
      });
      expect(unrelated.status).toBe(404);
      expect(requests).toEqual([`${route}?name=A%20B&limit=2`]);
    } finally {
      try {
        await vite?.close();
      } finally {
        backend.closeAllConnections();
        if (backend.listening)
          await new Promise<void>((resolve, reject) =>
            backend.close((error) => (error ? reject(error) : resolve())),
          );
      }
    }
  });
});
