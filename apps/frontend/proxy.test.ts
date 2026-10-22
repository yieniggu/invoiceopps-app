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

describe("APP12 S4 exact policy transport", () => {
  it("forwards real Vite policy GET/POST/PATCH with encoded version, query, JSON statuses and CSRF headers", async () => {
    const requests: string[] = [];
    const backend = createHttpServer(async (request, response) => {
      requests.push(request.url ?? "");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.statusCode =
        new URL(request.url!, "http://fixture.invalid").searchParams.get(
          "status",
        ) === "403"
          ? 403
          : request.method === "POST"
            ? 201
            : request.method === "PATCH"
              ? 409
              : 200;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          path: request.url,
          method: request.method,
          headers: request.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    let vite: ViteDevServer | undefined;
    try {
      backend.listen(0, "127.0.0.1");
      await once(backend, "listening");
      const address = backend.address();
      if (!address || typeof address === "string")
        throw new Error("Missing port");
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
          proxy: Object.fromEntries(
            Object.entries(config.server?.proxy ?? {}).map(([key, options]) => [
              key,
              {
                ...(typeof options === "string" ? {} : options),
                target: `http://127.0.0.1:${address.port}`,
              },
            ]),
          ),
        },
      });
      await vite.listen();
      const frontend = vite.httpServer?.address();
      if (!frontend || typeof frontend === "string")
        throw new Error("Missing frontend");
      const origin = `http://127.0.0.1:${frontend.port}`;
      const query = "?organizationId=org%20A&ownerType=group&ownerId=group%2B1";
      const version = encodeURIComponent("risk/v1 ?#é");
      for (const method of ["GET", "POST", "PATCH"]) {
        const path = `/business-policies${method === "PATCH" ? `/${version}` : ""}${query}`;
        const payload =
          method === "PATCH"
            ? { manualReviewThreshold: 1 }
            : { version: "v1", manualReviewThreshold: 0 };
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: {
            Accept: "application/json",
            Origin: origin,
            Cookie: "invoiceops_session=synthetic",
            "Content-Type": "application/json",
            "X-Forwarded-For": "192.0.2.10",
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(payload) }),
          signal: AbortSignal.timeout(2000),
        });
        expect(response.status).toBe(
          method === "POST" ? 201 : method === "PATCH" ? 409 : 200,
        );
        expect(response.headers.get("content-type")).toContain(
          "application/json",
        );
        const body = (await response.json()) as {
          path: string;
          method: string;
          headers: Record<string, string>;
          body: string;
        };
        expect(body.path).toBe(path);
        expect(body.method).toBe(method);
        expect(body.headers.host).toBe(`127.0.0.1:${frontend.port}`);
        expect(body.headers.origin).toBe(origin);
        expect(body.headers.cookie).toBe("invoiceops_session=synthetic");
        expect(body.headers["x-forwarded-proto"]).toBe("http");
        expect(body.headers["x-forwarded-for"]).toBe("192.0.2.10,127.0.0.1");
        expect(body.body).toBe(method === "GET" ? "" : JSON.stringify(payload));
      }
      for (const status of [200, 403]) {
        const path = `/organizations/00000000-0000-4000-8000-000000000001/groups?limit=50&status=${status}`;
        const response = await fetch(`${origin}${path}`, {
          headers: {
            Accept: "application/json",
            Cookie: "invoiceops_session=catalog-fixture",
            Origin: origin,
          },
          signal: AbortSignal.timeout(2000),
        });
        expect(response.status).toBe(status);
        expect(response.headers.get("content-type")).toContain(
          "application/json",
        );
        const body = (await response.json()) as {
          path: string;
          method: string;
          headers: Record<string, string>;
        };
        expect(body.path).toBe(path);
        expect(body.method).toBe("GET");
        expect(body.headers.cookie).toBe("invoiceops_session=catalog-fixture");
        expect(body.headers.origin).toBe(origin);
      }
      for (const path of [
        "/business-policies-extra",
        "/business-policies/v1/history",
        "/platform/unrelated",
        "/administration",
      ]) {
        const response = await fetch(`${origin}${path}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(2000),
        });
        expect(response.status).toBe(404);
      }
      expect(requests).toHaveLength(5);
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

  it("declares exact Vite/Nginx policy parity without rewriting encoded paths or opening platform", () => {
    const rule = Object.entries(config.server?.proxy ?? {}).find(
      ([key]) =>
        key.startsWith("^") && new RegExp(key).test("/business-policies"),
    );
    expect(rule).toBeDefined();
    if (!rule || typeof rule[1] === "string")
      throw new Error("Expected explicit policy rule");
    expect(rule[1]).toMatchObject({
      target: "http://localhost:3000",
      changeOrigin: false,
      xfwd: true,
    });
    expect(rule[1].rewrite).toBeUndefined();
    const source = readFileSync(
      new URL("./nginx.conf", import.meta.url),
      "utf8",
    );
    const root = source.match(
      /location\s+=\s+\/business-policies\s*\{([^}]+)\}/,
    );
    const version = source.match(
      /location\s+~\s+\^\/business-policies\/\s*\{([\s\S]+?)\n {2}\}/,
    );
    expect(root).not.toBeNull();
    expect(version).not.toBeNull();
    expect(version?.[1]).toContain(
      'if ($request_uri !~ "^/business-policies/[^/?]+([?].*)?$")',
    );
    expect(version?.[1]).toContain("return 404;");
    for (const block of [root?.[1], version?.[1]]) {
      expect(block).toContain("proxy_pass http://backend:3000;");
      expect(block).toContain("proxy_set_header Host $http_host;");
      expect(block).toContain(
        "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
      );
      expect(block).toContain("proxy_set_header X-Forwarded-Proto $scheme;");
      expect(block).not.toMatch(/rewrite|try_files/);
    }
    for (const path of [
      "/business-policies",
      "/business-policies?organizationId=o",
      "/business-policies/risk%2Fv1?ownerId=g",
    ])
      expect(new RegExp(rule[0]).test(path)).toBe(true);
    for (const path of [
      "/business-policies-extra",
      "/business-policies/v1/history",
      "/platform/other",
      "/administration",
    ])
      expect(new RegExp(rule[0]).test(path)).toBe(false);
  });
});
