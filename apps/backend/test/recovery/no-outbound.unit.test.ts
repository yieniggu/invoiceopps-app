import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

// G15 (RP0-20): P0 runs with MLflow, the Model API and blockchain off and with
// zero external connections. The browser side is audited request by request
// in the E2E journey; this is the server side: the backend source has no way
// to open an outbound connection other than its own PostgreSQL driver.

const backend = resolve(import.meta.dirname, "../..");
const source = resolve(backend, "src");
const generated = resolve(source, "generated");

const OUTBOUND = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /from\s+["'](?:node:)?(?:https?|http2|net|tls|dgram)["']/,
  /require\(\s*["'](?:node:)?(?:https?|http2|net|tls|dgram)["']\s*\)/,
  /import\(\s*["'](?:node:)?(?:https?|http2|net|tls|dgram)["']\s*\)/,
  /import\(\s*["'](?:axios|undici|got|node-fetch|ky|superagent)["']\s*\)/,
  /from\s+["'](?:axios|undici|got|node-fetch|ky|superagent)["']/,
];

// The runtime dependencies P0 needs; a new one (an HTTP client, a provider
// SDK) must be reviewed against G15 before it is added here.
const RUNTIME_DEPENDENCIES = [
  "@asteasolutions/zod-to-openapi",
  "@prisma/adapter-pg",
  "@prisma/client",
  "express",
  "pg",
  "swagger-ui-dist",
  "zod",
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return path === generated ? [] : sourceFiles(path);
    return /\.(?:ts|mts|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

describe("no outbound connections from the backend (G15)", () => {
  it("scans a non-empty source tree", () => {
    expect(sourceFiles(source).length).toBeGreaterThan(20);
  });

  it("recognises the outbound forms it guards against", () => {
    for (const line of [
      'const r = await fetch("https://api.example.com");',
      'import https from "node:https";',
      'import { request } from "http";',
      'import net from "net";',
      'const tls = require("node:tls");',
      'import axios from "axios";',
      'const { request } = await import("node:https");',
      'const undici = await import("undici");',
    ])
      expect(
        OUTBOUND.some((pattern) => pattern.test(line)),
        line,
      ).toBe(true);
    expect(
      OUTBOUND.some((pattern) => pattern.test('import pg from "pg";')),
    ).toBe(false);
  });

  it("has no HTTP, socket or provider client in its source", () => {
    const offenders = sourceFiles(source).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return OUTBOUND.filter((pattern) => pattern.test(text)).map(
        (pattern) => `${relative(backend, file)} ${pattern}`,
      );
    });
    expect(offenders).toEqual([]);
  });

  it("depends at runtime only on the reviewed packages", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(backend, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [...RUNTIME_DEPENDENCIES].sort(),
    );
  });
});
