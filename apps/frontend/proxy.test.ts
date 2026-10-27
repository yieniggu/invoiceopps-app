// @vitest-environment node
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { createServer, type ProxyOptions, type ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";
import config from "./vite.config";

const expectedTarget = `http://127.0.0.1:${process.env.PORT || "4380"}`;
const API_PREFIX = "/api/";
const OPENAPI_PATH = "/openapi.json";

// Vite matches a "^" key as a RegExp and any other key as a URL prefix.
function matchingKeys(path: string): string[] {
  return Object.keys(config.server?.proxy ?? {}).filter((key) =>
    key.startsWith("^") ? new RegExp(key).test(path) : path.startsWith(key),
  );
}

function ruleFor(key: string): ProxyOptions {
  const rule = (config.server?.proxy ?? {})[key];
  if (!rule || typeof rule === "string")
    throw new Error(`Expected explicit proxy options for ${key}`);
  return rule;
}

async function withProxiedBackend(
  handler: Parameters<typeof createHttpServer>[1],
  run: (context: { origin: string; port: number }) => Promise<void>,
) {
  const backend = createHttpServer(handler);
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
      throw new Error("Missing frontend port");
    await run({
      origin: `http://127.0.0.1:${frontend.port}`,
      port: frontend.port,
    });
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
}

const BARE_API_KEY = "^/api(?:\\?|$)";

describe("RP0 Vite proxy surface is /api/, bare /api and /openapi.json", () => {
  it("declares only the /api/ prefix, the bare /api and the exact OpenAPI document", () => {
    const keys = Object.keys(config.server?.proxy ?? {});

    expect(keys).toHaveLength(3);
    expect(keys).toContain(API_PREFIX);
    expect(keys).toContain(BARE_API_KEY);
    const openApiKey = keys.find(
      (key) => key !== API_PREFIX && key !== BARE_API_KEY,
    );
    expect(openApiKey?.startsWith("^")).toBe(true);
    const pattern = new RegExp(openApiKey!);
    expect(pattern.test(OPENAPI_PATH)).toBe(true);
    for (const path of [
      "/openapi.json/extra",
      "/openapi.jsonx",
      "/x/openapi.json",
      "/openapi",
    ])
      expect(pattern.test(path), path).toBe(false);
  });

  it("shares one same-origin rule that never rewrites Host or the path", () => {
    for (const key of Object.keys(config.server?.proxy ?? {})) {
      const rule = ruleFor(key);
      expect(rule, key).toMatchObject({
        target: expectedTarget,
        changeOrigin: false,
        xfwd: true,
      });
      expect(rule.rewrite, key).toBeUndefined();
    }
  });

  it("proxies API and OpenAPI paths and nothing else", () => {
    for (const path of [
      "/api/v1/auth/login",
      "/api/v1/auth/profile",
      "/api/v1/platform/organizations/o%2Fx/members/u",
      "/api/v1/invoices?limit=2",
      "/api/v1/unknown",
      "/openapi.json",
      "/openapi.json?v=1",
    ])
      expect(matchingKeys(path), path).toHaveLength(1);
  });

  it("proxies the bare /api (with or without a query) and nothing like it", () => {
    for (const path of ["/api", "/api?x=1"])
      expect(matchingKeys(path), path).toEqual([BARE_API_KEY]);
    for (const path of ["/apix", "/api-docs", "/api%2F", "/API"])
      expect(matchingKeys(path), path).toEqual([]);
  });

  it("no longer carries any old root functional rule", () => {
    for (const path of [
      "/auth/login",
      "/auth/profile",
      "/profile",
      "/groups",
      "/invoices",
      "/invoices/abc",
      "/organizations/o/groups",
      "/business-policies",
      "/business-policies/v1",
      "/platform/organizations",
      "/platform/organizations/o/members",
      "/platform/organizations/o/members/u",
      "/apix/v1",
      "/api-docs",
      "/health/live",
    ])
      expect(matchingKeys(path), path).toEqual([]);
  });
});

describe("RP0 nginx surface is exactly /api/ and = /openapi.json", () => {
  const source = readFileSync(new URL("./nginx.conf", import.meta.url), "utf8");

  function block(header: string): string {
    const start = source.indexOf(`location ${header} {`);
    expect(start, `location ${header}`).toBeGreaterThanOrEqual(0);
    return source.slice(start, source.indexOf("}", start));
  }

  it("answers the bare /api with a JSON 404 instead of the SPA 301", () => {
    const start = source.indexOf("location = /api {");
    const body = source.slice(start, source.indexOf("\n  }", start));

    expect(body).toContain(
      `return 404 '{"error":{"code":"NOT_FOUND","message":"Route not found"}}';`,
    );
    expect(body).toContain("default_type application/json;");
    expect(body).not.toMatch(/proxy_pass|try_files|rewrite/);
    // The exact-match location wins over the prefix and the SPA fallback.
    expect(source.indexOf("location = /api {")).toBeLessThan(
      source.indexOf("location /api/ {"),
    );
  });

  it("declares only /api/, = /api, = /openapi.json and the SPA fallback", () => {
    const locations = [...source.matchAll(/location\s+([^{]+?)\s*\{/g)].map(
      (match) => match[1],
    );

    expect(locations.sort()).toEqual(
      ["/", "/api/", "= /api", "= /openapi.json"].sort(),
    );
    expect(source).toContain("try_files $uri $uri/ /index.html;");
    expect(source).not.toMatch(/location\s+~/);
  });

  it("forwards the proxied locations to the backend keeping Host and the URI untouched", () => {
    for (const header of ["/api/", "= /openapi.json"]) {
      const body = block(header);
      expect(body, header).toMatch(/proxy_pass http:\/\/backend:3000;/);
      expect(body, header).toContain("proxy_set_header Host $http_host;");
      expect(body, header).toContain(
        "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
      );
      expect(body, header).toContain(
        "proxy_set_header X-Forwarded-Proto $scheme;",
      );
      expect(body, header).not.toMatch(/rewrite|try_files/);
    }
  });
});

describe("RP0 real Vite HTTP forwarding", () => {
  it("forwards the bare /api to the backend and returns its 404 envelope", async () => {
    const seen: string[] = [];
    await withProxiedBackend(
      (request, response) => {
        seen.push(request.url ?? "");
        response.statusCode = 404;
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            error: { code: "NOT_FOUND", message: "Route not found" },
          }),
        );
      },
      async ({ origin }) => {
        for (const path of ["/api", "/api?x=1"]) {
          const response = await fetch(`${origin}${path}`, {
            redirect: "manual",
            signal: AbortSignal.timeout(5000),
          });
          expect(response.status, path).toBe(404);
          expect(await response.json()).toEqual({
            error: { code: "NOT_FOUND", message: "Route not found" },
          });
        }
        expect(seen).toEqual(["/api", "/api?x=1"]);
      },
    );
  });

  it("RV-096: the backend receives the original Host and Origin for POST /api/v1/auth/login", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    await withProxiedBackend(
      async (request, response) => {
        requests.push({ url: request.url ?? "", method: request.method ?? "" });
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            headers: request.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
      async ({ origin, port }) => {
        const payload = JSON.stringify({ rut: "12.345.678-5", password: "x" });
        const response = await fetch(`${origin}/api/v1/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
            Cookie: "invoiceops_session=synthetic",
            "X-Forwarded-For": "192.0.2.10",
          },
          body: payload,
          signal: AbortSignal.timeout(5000),
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          headers: Record<string, string>;
          body: string;
        };
        expect(body.headers.host).toBe(`127.0.0.1:${port}`);
        expect(body.headers.origin).toBe(origin);
        expect(body.headers.cookie).toBe("invoiceops_session=synthetic");
        expect(body.headers["x-forwarded-proto"]).toBe("http");
        expect(body.headers["x-forwarded-for"]).toBe("192.0.2.10,127.0.0.1");
        expect(body.body).toBe(payload);
        expect(requests).toEqual([
          { url: "/api/v1/auth/login", method: "POST" },
        ]);
      },
    );
  });

  it("forwards /openapi.json and rejects old root paths without reaching the backend", async () => {
    const requests: string[] = [];
    await withProxiedBackend(
      (request, response) => {
        requests.push(request.url ?? "");
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ openapi: "3.1.0" }));
      },
      async ({ origin }) => {
        const document = await fetch(`${origin}${OPENAPI_PATH}`, {
          signal: AbortSignal.timeout(5000),
        });
        expect(document.status).toBe(200);

        for (const path of [
          "/auth/login",
          "/profile",
          "/platform/organizations",
          "/business-policies",
          "/health/live",
        ]) {
          const response = await fetch(`${origin}${path}`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(5000),
          });
          expect(response.status, path).toBe(404);
        }
        expect(requests).toEqual([OPENAPI_PATH]);
      },
    );
  });
});

describe("RP0 real Vite forwarding of encoded policy requests", () => {
  const VERSION_PATH = "/api/v1/business-policies/risk%2Fv1?ownerId=g%2B1";
  const LIST_PATH = "/api/v1/business-policies?ownerId=g%2B1&q=a%26b%3Dc";

  it.each([
    ["GET", LIST_PATH, undefined, 200],
    [
      "POST",
      LIST_PATH,
      { version: "risk/v1", manualReviewThreshold: 0.5 },
      201,
    ],
    ["PATCH", VERSION_PATH, { manualReviewThreshold: 0.2 }, 200],
    ["PATCH", VERSION_PATH, { manualReviewThreshold: 0.2 }, 403],
    ["PATCH", VERSION_PATH, { manualReviewThreshold: 0.2 }, 409],
    ["POST", LIST_PATH, { version: "risk/v1", manualReviewThreshold: 2 }, 400],
  ] as const)(
    "%s %s keeps the raw URL, method, JSON, cookie and Origin and passes %i through",
    async (method, path, payload, status) => {
      const seen: Array<{ url: string; method: string }> = [];
      await withProxiedBackend(
        async (request, response) => {
          seen.push({ url: request.url ?? "", method: request.method ?? "" });
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          response.statusCode = status;
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              status,
              headers: request.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
        async ({ origin, port }) => {
          const response = await fetch(`${origin}${path}`, {
            method,
            headers: {
              Accept: "application/json",
              Origin: origin,
              Cookie: "invoiceops_session=synthetic",
              ...(payload === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
            signal: AbortSignal.timeout(5000),
          });

          expect(response.status).toBe(status);
          expect(response.headers.get("content-type")).toContain(
            "application/json",
          );
          const body = (await response.json()) as {
            status: number;
            headers: Record<string, string>;
            body: string;
          };
          expect(body.status).toBe(status);
          expect(body.body).toBe(
            payload === undefined ? "" : JSON.stringify(payload),
          );
          expect(body.headers.host).toBe(`127.0.0.1:${port}`);
          expect(body.headers.origin).toBe(origin);
          expect(body.headers.cookie).toBe("invoiceops_session=synthetic");
          if (payload !== undefined) {
            expect(body.headers["content-type"]).toContain("application/json");
          }
          // Identical raw URL: %2F and %2B stay encoded, nothing is rewritten.
          expect(seen).toEqual([{ url: path, method }]);
        },
      );
    },
  );
});

describe("backend proxy target follows PORT", () => {
  async function targetWith(port: string | undefined) {
    vi.resetModules();
    if (port === undefined) delete process.env.PORT;
    else process.env.PORT = port;
    try {
      const fresh = (await import("./vite.config")).default;
      const rule = (fresh.server?.proxy ?? {})[API_PREFIX];
      return typeof rule === "string" ? rule : rule?.target;
    } finally {
      vi.resetModules();
    }
  }

  it("defaults to 4380 when PORT is unset or empty and honors PORT otherwise", async () => {
    const original = process.env.PORT;
    try {
      expect(await targetWith(undefined)).toBe("http://127.0.0.1:4380");
      expect(await targetWith("4999")).toBe("http://127.0.0.1:4999");
      expect(await targetWith("")).toBe("http://127.0.0.1:4380");
    } finally {
      if (original === undefined) delete process.env.PORT;
      else process.env.PORT = original;
    }
  });
});
