// @vitest-environment node
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { createServer, type ViteDevServer } from "vite";
import { describe, expect, it } from "vitest";
import config from "./vite.config";

const key = Object.keys(config.server?.proxy ?? {}).find((key) =>
  key.includes("/members"),
);
const nearMisses = [
  "/platform/organizations-extra",
  "/platform/organizations/o/memberships",
  "/platform/organizations/o/members/u/extra",
  "/platform/organizations/o/members/",
  "/platform/organizations/o/bootstrap",
  "/platform/organizations/o/transfer",
  "/platform/administrator",
  "/platform/bootstrap",
  "/admin/mlflow/provision",
];
describe("APP12 S7 bounded membership transport", () => {
  it("bounds raw Vite/Nginx membership paths without opening other platform operations", () => {
    expect(key).toBeDefined();
    const pattern = new RegExp(key!);
    for (const path of [
      "/platform/organizations/o/members",
      "/platform/organizations/o/members/u?x=1",
      "/platform/organizations/o%2Fx/members/u%2Fy",
    ])
      expect(pattern.test(path)).toBe(true);
    for (const path of [
      ...nearMisses,
      "/platform/organizations",
      "/platform/organizations/o/groups",
    ])
      expect(pattern.test(path)).toBe(false);
    const source = readFileSync(
      new URL("./nginx.conf", import.meta.url),
      "utf8",
    );
    const block = source.match(
      /location ~ \^\/platform\/organizations\/.+? \{([\s\S]+?)\n {2}\}/,
    )?.[1];
    expect(block).toBeDefined();
    expect(block).toContain(
      'if ($request_uri !~ "^/platform/organizations/[^/?]+/members(/[^/?]+)?([?].*)?$")',
    );
    expect(block).toContain("return 404;");
    expect(block).toContain("proxy_pass http://backend:3000;");
    expect(block).toContain("proxy_set_header Host $http_host;");
    expect(block).toContain(
      "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    );
    expect(block).toContain("proxy_set_header X-Forwarded-Proto $scheme;");
    expect(block).not.toMatch(/rewrite|try_files/);
    expect(source).not.toMatch(/location\s+(?:\^~\s+)?\/platform\//);
  });
  it("forwards actual POST/PATCH/DELETE JSON and 204, preserves encoded IDs/CSRF headers, and rejects near misses", async () => {
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
        const path = `/platform/organizations/${encodeURIComponent("org/a")}/members${method === "POST" ? "" : `/${encodeURIComponent("user/b")}`}?status=${status}`;
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
          signal: AbortSignal.timeout(2000),
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
      for (const path of nearMisses)
        expect(
          (
            await fetch(`${origin}${path}`, {
              headers: { Accept: "application/json" },
              signal: AbortSignal.timeout(2000),
            })
          ).status,
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
