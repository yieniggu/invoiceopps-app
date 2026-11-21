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
        "PUBLIC_ORIGIN",
        "INTERNAL_INTROSPECTION_SECRET",
        // MLOPS-05 Models section.
        "MODEL_API_URL",
        "MODEL_API_SERVICE_TOKEN",
        "MLFLOW_GATEWAY_INTERNAL_URL",
        "GATEWAY_SERVICE_READ_TOKEN",
        "MLFLOW_PUBLIC_URL",
        "MODEL_DEPLOYMENT_MAX_ACTIVE_PER_SCOPE",
        "MODEL_DEPLOY_CHECK_MAX_PER_HOUR",
        // MLOPS-06 automatic predictions worker.
        "PREDICTION_WORKER_DISABLED",
        "PREDICTION_WORKER_POLL_MS",
        "PREDICTION_MAX_ATTEMPTS",
        "PREDICTION_CONCURRENCY",
        "PREDICTION_BATCH_SIZE",
        "PREDICTION_RETRY_BASE_MS",
        "PREDICTION_RETRY_MAX_MS",
        "PREDICTION_MAX_JOB_AGE_MS",
        // Queue gauge and models reconcile (background tasks).
        "PREDICTION_METRICS_INTERVAL_MS",
        "PREDICTION_FAILED_WARN_THRESHOLD",
        "PREDICTION_FAILED_WINDOW_MS",
        "MODELS_RECONCILE_INTERVAL_MS",
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

  it("does not configure blockchain integrations at startup", () => {
    const source = readFileSync(resolve("src/server.ts"), "utf8");
    expect(source).not.toMatch(/EVM|ANVIL|RPC_URL/i);
  });
});
