// @vitest-environment node
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { createServer, type ViteDevServer } from "vite";
import { describe, expect, it } from "vitest";
import config from "./vite.config";

const key = Object.keys(config.server?.proxy ?? {}).find((key) =>
  key.startsWith("^/evidence-"),
);
const nearMisses = [
  "/evidence",
  "/evidence-anchor",
  "/evidence-records-extra",
  "/evidence-records/id/proofs/id",
  "/evidence-batches/id/admin",
  "/evidence-batches/id/proofs/id/extra",
  "/evidence-batches/id/anchors",
  "/admin/evidence-batches",
];
describe("APP12 S6 exact read namespaces", () => {
  it("declares bounded Vite/Nginx parity, encoded single segments and unchanged forwarding headers", () => {
    expect(key).toBeDefined();
    const rule = config.server?.proxy?.[key!];
    expect(rule).toMatchObject({
      target: "http://localhost:3000",
      changeOrigin: false,
      xfwd: true,
    });
    const pattern = new RegExp(key!);
    for (const path of [
      "/evidence-records",
      "/evidence-records/a%2Fb?ownerId=g",
      "/evidence-batches?limit=2",
      "/evidence-batches/id",
      "/evidence-batches/a%2Fb/proofs/c%2Fd?ownerId=g",
    ])
      expect(pattern.test(path)).toBe(true);
    for (const path of nearMisses) expect(pattern.test(path)).toBe(false);
    const source = readFileSync(
      new URL("./nginx.conf", import.meta.url),
      "utf8",
    );
    const block = source.match(
      /location ~ \^\/evidence-\(records\|batches\)\(\/\|\$\) \{([\s\S]+?)\n {2}\}/,
    )?.[1];
    expect(block).toBeDefined();
    expect(block).toContain(
      'if ($request_uri !~ "^/evidence-(records(/[^/?]+)?|batches(/[^/?]+(/proofs/[^/?]+)?)?)([?].*)?$")',
    );
    expect(block).toContain("return 404;");
    expect(block).toContain("proxy_pass http://backend:3000;");
    expect(block).toContain("proxy_set_header Host $http_host;");
    expect(block).toContain(
      "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    );
    expect(block).toContain("proxy_set_header X-Forwarded-Proto $scheme;");
    expect(block).not.toMatch(/rewrite|try_files/);
    expect(source).not.toMatch(/location\s+(?:\^~\s+)?\/evidence\b/);
  });
  it("forwards actual root/detail/proof GETs and JSON errors, cookies, origin and encoded paths without SPA HTML or near-miss forwarding", async () => {
    const requests: string[] = [];
    const backend = createHttpServer((request, response) => {
      requests.push(request.url ?? "");
      response.statusCode = Number(
        new URL(request.url!, "http://fixture.invalid").searchParams.get(
          "status",
        ) ?? 200,
      );
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          path: request.url,
          method: request.method,
          headers: request.headers,
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
      const rule = config.server?.proxy?.[key!];
      if (!rule || typeof rule === "string")
        throw new Error("Missing explicit evidence proxy rule");
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
            [key!]: { ...rule, target: `http://127.0.0.1:${address.port}` },
          },
        },
      });
      await vite.listen();
      const frontend = vite.httpServer?.address();
      if (!frontend || typeof frontend === "string")
        throw new Error("Missing frontend port");
      const origin = `http://127.0.0.1:${frontend.port}`;
      for (const [path, status] of [
        ["/evidence-records", 200],
        ["/evidence-records/a%2Fb", 404],
        ["/evidence-batches", 403],
        ["/evidence-batches/b%20c", 401],
        ["/evidence-batches/a%2Fb/proofs/c%2Fd", 409],
      ] as const) {
        const url = `${path}?organizationId=org%20A&ownerType=group&ownerId=g%2B1&status=${status}`;
        const response = await fetch(`${origin}${url}`, {
          headers: {
            Accept: "application/json",
            Origin: origin,
            Cookie: "invoiceops_session=synthetic",
            "X-Forwarded-For": "192.0.2.10",
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
        expect(body.path).toBe(url);
        expect(body.method).toBe("GET");
        expect(body.headers.host).toBe(`127.0.0.1:${frontend.port}`);
        expect(body.headers.origin).toBe(origin);
        expect(body.headers.cookie).toBe("invoiceops_session=synthetic");
        expect(body.headers["x-forwarded-proto"]).toBe("http");
        expect(body.headers["x-forwarded-for"]).toBe("192.0.2.10,127.0.0.1");
      }
      for (const path of nearMisses)
        expect(
          (
            await fetch(`${origin}${path}`, {
              headers: { Accept: "application/json" },
              signal: AbortSignal.timeout(2000),
            })
          ).status,
        ).toBe(404);
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
});
