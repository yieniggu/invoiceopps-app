// @vitest-environment node
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { createServer, type ViteDevServer } from "vite";
import { describe, expect, it } from "vitest";
import config from "./vite.config";

// Administration surfaces (platform discovery, memberships, business policies,
// organization groups) no longer own transport rules: they travel through the
// single /api/ prefix, so the encoded-segment bounds live in the backend router.
const ORG = encodeURIComponent("org/a");
const USER = encodeURIComponent("user/b");
const VERSION = encodeURIComponent("risk/v1 ?#é");
const oldAdministrationPaths = [
  "/platform/organizations",
  `/platform/organizations/${ORG}/members`,
  `/platform/organizations/${ORG}/members/${USER}`,
  "/business-policies",
  `/business-policies/${VERSION}`,
  "/organizations/00000000-0000-4000-8000-000000000001/groups",
  "/platform/organizations-extra",
  "/platform/administrator",
];

function proxiesPath(path: string): boolean {
  return Object.keys(config.server?.proxy ?? {}).some((key) =>
    key.startsWith("^") ? new RegExp(key).test(path) : path.startsWith(key),
  );
}

describe("RP0 administration transport under /api/v1", () => {
  it("has no dedicated membership, discovery or policy proxy rule", () => {
    expect(
      Object.keys(config.server?.proxy ?? {}).filter((key) =>
        /members|platform|business-policies|organizations(?!\.)/.test(key),
      ),
    ).toEqual([]);
    for (const path of oldAdministrationPaths)
      expect(proxiesPath(path), path).toBe(false);
  });

  it("drops the nginx regex locations and URI guards for administration paths", () => {
    const source = readFileSync(
      new URL("./nginx.conf", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(
      /\/platform\/|\/business-policies|\/organizations/,
    );
    expect(source).not.toMatch(/location\s+~/);
    expect(source).not.toContain("$request_uri");
    expect(source).toMatch(/location\s+\/api\/\s*\{/);
  });

  it("forwards real Vite POST/PATCH/DELETE under /api/v1 keeping encoded IDs, JSON, 204 and CSRF headers", async () => {
    const requests: string[] = [];
    const backend = createHttpServer(async (request, response) => {
      requests.push(request.url ?? "");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const requested = new URL(
        request.url!,
        "http://fixture.invalid",
      ).searchParams.get("status");
      response.statusCode = Number(
        requested ??
          (request.method === "POST"
            ? 201
            : request.method === "DELETE"
              ? 204
              : 200),
      );
      if (response.statusCode === 204) {
        response.end();
        return;
      }
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
        throw new Error("Missing fixture port");
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
      const origin = `http://127.0.0.1:${frontend.port}`;
      for (const [method, status] of [
        ["POST", 201],
        ["PATCH", 200],
        ["DELETE", 204],
        ["PATCH", 400],
        ["PATCH", 401],
        ["PATCH", 403],
        ["PATCH", 404],
        ["PATCH", 409],
      ] as const) {
        const path = `/api/v1/platform/organizations/${ORG}/members${method === "POST" ? "" : `/${USER}`}?status=${status}`;
        const payload =
          method === "POST"
            ? { userId: "user/b", role: "ADMIN" }
            : { role: "USER" };
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: {
            Accept: "application/json",
            Origin: origin,
            Cookie: "invoiceops_session=synthetic",
            "Content-Type": "application/json",
            "X-Forwarded-For": "192.0.2.10",
          },
          ...(method === "DELETE" ? {} : { body: JSON.stringify(payload) }),
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status).toBe(status);
        if (status === 204) expect(await response.text()).toBe("");
        else {
          expect(response.headers.get("content-type")).toContain(
            "application/json",
          );
          const body = (await response.json()) as {
            path: string;
            method: string;
            body: string;
            headers: Record<string, string>;
          };
          expect(body.path).toBe(path);
          expect(body.method).toBe(method);
          expect(body.body).toBe(JSON.stringify(payload));
          expect(body.headers.host).toBe(`127.0.0.1:${frontend.port}`);
          expect(body.headers.origin).toBe(origin);
          expect(body.headers.cookie).toBe("invoiceops_session=synthetic");
          expect(body.headers["x-forwarded-proto"]).toBe("http");
          expect(body.headers["x-forwarded-for"]).toBe("192.0.2.10,127.0.0.1");
        }
      }
      for (const path of oldAdministrationPaths)
        expect(
          (
            await fetch(`${origin}${path}`, {
              headers: { Accept: "application/json" },
              signal: AbortSignal.timeout(5000),
            })
          ).status,
          path,
        ).toBe(404);
      expect(requests).toHaveLength(8);
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
