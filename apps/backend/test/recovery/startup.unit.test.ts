import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "generated" ? [] : sourceFiles(path);
    }
    return /\.(ts|tsx|mts|js|mjs)$/.test(entry.name) ? [path] : [];
  });
}

// Every way of reading process.env: dot access, bracket access with a literal
// and any other use (destructuring, aliasing, dynamic keys), which is reported
// as "<dynamic>" so it can never be silently allowed.
function environmentReads(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(
    /process\.env(?:\.([A-Za-z0-9_]+)|\[\s*["'`]([A-Za-z0-9_]+)["'`]\s*\])?/g,
  )) {
    names.push(match[1] ?? match[2] ?? "<dynamic>");
  }
  return names;
}

describe("backend startup configuration", () => {
  it("reads only the documented variables from the environment", () => {
    const names = sourceFiles(resolve("src")).flatMap((file) =>
      environmentReads(readFileSync(file, "utf8")),
    );
    expect(new Set(names)).toEqual(
      new Set([
        "DATABASE_URL",
        "PORT",
        "HOST",
        "NODE_ENV",
        "AUTH_RATE_LIMIT_DISABLED",
        "AUTH_RATE_LIMIT_MAX_ATTEMPTS",
        "AUTH_RATE_LIMIT_WINDOW_MS",
        "AUTH_TRUST_PROXY_HOPS",
      ]),
    );
  });

  it("detects bracket, destructuring and dynamic environment reads", () => {
    expect(environmentReads('process.env["MLFLOW_URL"]')).toEqual([
      "MLFLOW_URL",
    ]);
    expect(environmentReads("const { RPC_URL } = process.env;")).toEqual([
      "<dynamic>",
    ]);
    expect(environmentReads("process.env[name]")).toEqual(["<dynamic>"]);
  });

  it("does not configure ML or blockchain integrations at startup", () => {
    const source = readFileSync(resolve("src/server.ts"), "utf8");
    expect(source).not.toMatch(/MODEL_API|MLFLOW|EVM|ANVIL|RPC_URL/i);
  });
});
