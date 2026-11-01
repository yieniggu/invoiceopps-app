import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import request from "../support/request.js";

function buildApp() {
  return createApp({ isReady: async () => true });
}

const LOCAL_ASSETS = [
  ["/docs/swagger-ui.css", /text\/css/],
  ["/docs/swagger-ui-bundle.js", /javascript/],
  ["/docs/swagger-initializer.js", /javascript/],
  ["/docs/favicon-32x32.png", /image\/png/],
] as const;

describe("AC-15 Swagger UI at /docs", () => {
  it("serves /docs/ as HTML that references only local assets and our initializer", async () => {
    const response = await request(buildApp()).get("/docs/");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
    expect(response.headers["set-cookie"]).toBeUndefined();
    const html = response.text;
    expect(html).toContain('id="swagger-ui"');
    expect(html).toContain('href="/docs/swagger-ui.css"');
    expect(html).toContain('src="/docs/swagger-ui-bundle.js"');
    expect(html).toContain('src="/docs/swagger-initializer.js"');
    // No CDN, no petstore, no inline script.
    expect(html).not.toMatch(/(?:src|href)=["']?(?:https?:)?\/\//i);
    expect(html).not.toContain("petstore");
    for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
      expect(match[1], "every script is external").toMatch(/\bsrc=/);
    }
    expect(html).not.toMatch(/<script\b[^>]*>\s*[^<\s]/i);
  });

  it("redirects /docs to the canonical /docs/", async () => {
    const response = await request(buildApp()).get("/docs");

    expect(response.status).toBe(301);
    expect(response.headers.location).toBe("/docs/");
  });

  it("serves the initializer with the same-origin, non-persistent, validator-free configuration", async () => {
    const response = await request(buildApp()).get(
      "/docs/swagger-initializer.js",
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/javascript/);
    expect(response.headers["cache-control"]).toMatch(/no-cache/);
    const script = response.text;
    expect(script).toMatch(/url:\s*"\/openapi\.json"/);
    expect(script).toMatch(/persistAuthorization:\s*false/);
    expect(script).toMatch(/validatorUrl:\s*null/);
    expect(script).toMatch(/withCredentials:\s*false/);
    expect(script).toMatch(/requestInterceptor:\s*function/);
    expect(script).toMatch(/request\.credentials\s*=\s*"omit"/);
    expect(script).not.toMatch(/https?:\/\//);
    expect(script).not.toContain("petstore");
  });

  it.each(LOCAL_ASSETS)(
    "serves %s from the local swagger-ui-dist package with the right content type",
    async (path, contentType) => {
      const response = await request(buildApp()).get(path);

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toMatch(contentType);
      expect(response.headers["set-cookie"]).toBeUndefined();
    },
  );

  it("caches the pinned dist assets but revalidates the page and the initializer", async () => {
    const app = buildApp();
    const bundle = await request(app).get("/docs/swagger-ui-bundle.js");
    const page = await request(app).get("/docs/");

    expect(bundle.headers["cache-control"]).toMatch(/public, max-age=\d+/);
    expect(page.headers["cache-control"]).toMatch(/no-cache/);
  });

  it("serves the bundled initializer of the dist neither as ours nor the petstore index", async () => {
    const app = buildApp();
    for (const path of [
      "/docs/index.html",
      "/docs/index.js",
      "/docs/swagger-ui.css.map",
      "/docs/oauth2-redirect.html",
      "/docs/package.json",
      "/docs/../package.json",
      "/docs/%2e%2e/package.json",
    ]) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(404);
    }
  });

  it("is public: no cookie needed and an Authorization header is ignored (the guard is only under /api)", async () => {
    const app = buildApp();
    for (const path of ["/docs/", "/docs/swagger-initializer.js"]) {
      const withBearer = await request(app)
        .get(path)
        .set("Authorization", "Bearer iop_not-a-real-token");
      expect(withBearer.status, path).toBe(200);
      const withBasic = await request(app)
        .get(path)
        .set("Authorization", "Basic abc");
      expect(withBasic.status, path).toBe(200);
    }
  });

  it("only answers GET and HEAD and is not under /api", async () => {
    const app = buildApp();

    expect((await request(app).post("/docs/")).status).toBe(404);
    expect((await request(app).get("/api/v1/docs/")).status).toBe(404);
  });
});

describe("CR-331 Content-Security-Policy on the docs router", () => {
  const CSP =
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

  it.each([
    "/docs",
    "/docs/",
    "/docs/swagger-initializer.js",
    "/docs/swagger-ui.css",
    "/docs/swagger-ui-bundle.js",
    "/docs/favicon-16x16.png",
  ])("sends the policy on %s", async (path) => {
    const response = await request(buildApp()).get(path);

    expect(response.headers["content-security-policy"]).toBe(CSP);
  });

  it("allows no inline script, eval or third-party origin", () => {
    expect(CSP).not.toMatch(/unsafe-eval|https?:|\*/);
    expect(CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(CSP).not.toMatch(/default-src[^;]*unsafe-inline/);
  });

  it("does not leak the policy to the API or to a look-alike path", async () => {
    for (const path of ["/openapi.json", "/docsx", "/api/v1/auth/profile"]) {
      const response = await request(buildApp()).get(path);
      expect(response.headers["content-security-policy"], path).toBeUndefined();
    }
  });
});
