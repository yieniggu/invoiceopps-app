import { spawn as nodeSpawn } from "node:child_process";
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
  // A stuck DROP/terminate must fail the reset, not wait for the caller's timeout.
  return new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60_000,
    query_timeout: 65_000,
  });
}

/**
 * Runs a command and resolves with a `spawnSync`-shaped result. The child leads
 * its own process group (POSIX), so on timeout the whole group is killed: a
 * `pnpm exec` wrapper would die alone while the prisma process (and its schema
 * engine) kept running against the database. `spawnImpl`, `platform` and
 * `killGroup` are
 * injectable for tests.
 */
export function spawnWithGroupKill(
  command,
  args,
  {
    cwd,
    env,
    timeout,
    spawnImpl = nodeSpawn,
    platform = process.platform,
    killGroup = (pid) => process.kill(-pid, "SIGKILL"),
  } = {},
) {
  return new Promise((resolveResult) => {
    const posix = platform !== "win32";
    // Windows (best effort; the E2E launcher targets macOS and Linux): the
    // prisma bin is a `.cmd` shim, which can only be spawned through a shell.
    const child = spawnImpl(posix ? command : `"${command}"`, args, {
      cwd,
      env,
      shell: !posix,
      detached: posix,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    // The launcher exiting (a signal, a crash) must not orphan the group.
    const killOnExit = () => {
      try {
        if (posix) killGroup(child.pid);
      } catch {
        // already gone
      }
    };
    process.once("exit", killOnExit);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("exit", killOnExit);
      resolveResult({ stdout, stderr, ...result });
    };
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          try {
            if (posix) killGroup(child.pid);
            else child.kill("SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, timeout)
      : undefined;
    child.on("error", (error) => finish({ status: null, error }));
    child.on("close", (status) =>
      finish(
        timedOut
          ? {
              status: null,
              error: new Error(
                `timed out after ${timeout}ms (process group killed)`,
              ),
            }
          : { status },
      ),
    );
  });
}

/** Prisma CLI of this package, spawned directly (no pnpm wrapper in between). */
export const prismaBin = resolve(
  backendDirectory,
  "node_modules/.bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma",
);

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
  spawn = spawnWithGroupKill,
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

  const result = await spawn(prismaBin, ["migrate", "deploy"], {
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
  log("reset: migrations applied");
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
