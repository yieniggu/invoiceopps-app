import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertRecoveryTarget,
  expectedDatabasePort,
  parseResetArguments,
  safeDecode,
} from "./recovery-db-guards.mjs";

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function defaultCreateClient(connectionString) {
  // Imported lazily so a guard failure never loads the driver.
  const { default: pg } = await import("pg");
  return new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
}

function redact(text, secrets) {
  // Longest first so a full URL is replaced before the password it contains.
  return [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((result, secret) => result.split(secret).join("[redacted]"), text);
}

export async function runRecoveryReset({
  argv = process.argv.slice(2),
  env = process.env,
  allowedNames,
  createClient = defaultCreateClient,
  spawn = spawnSync,
  log = console.info,
} = {}) {
  // All guards run before any connection or child process.
  const { url, confirmReset } = parseResetArguments(argv, env);
  const target = assertRecoveryTarget(url, {
    confirmReset,
    allowedNames,
    expectedPort: expectedDatabasePort(env),
  });
  const parsed = new URL(url);
  const secrets = [
    url,
    target.url,
    target.maintenanceUrl,
    parsed.password,
    safeDecode(parsed.password),
  ];

  log(`reset: target ${target.sanitized}`);
  const client = await createClient(target.maintenanceUrl);
  try {
    await client.connect();
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [target.databaseName],
    );
    // The name is one of the allowed constants validated by the guard above.
    await client.query(
      `DROP DATABASE IF EXISTS "${target.databaseName}" WITH (FORCE)`,
    );
    await client.query(`CREATE DATABASE "${target.databaseName}"`);
  } catch (error) {
    throw new Error(
      `reset: database recreation failed: ${redact(String(error?.message ?? error), secrets)}`,
    );
  } finally {
    await client.end().catch(() => {});
  }
  log("reset: database recreated");

  const result = spawn("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: backendDirectory,
    encoding: "utf8",
    timeout: 180_000,
    env: {
      PATH: env.PATH,
      HOME: env.HOME,
      NO_COLOR: "1",
      DATABASE_URL: target.url,
    },
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `reset: prisma migrate deploy failed (exit ${result.status ?? "none"}): ${redact(`${result.stderr ?? ""}${result.stdout ?? ""}`, secrets).slice(-1500)}`,
    );
  }
  log("reset: consolidated migration applied");
  return { databaseName: target.databaseName, url: target.url };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runRecoveryReset().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
