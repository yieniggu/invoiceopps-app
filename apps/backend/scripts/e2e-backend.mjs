// Starts the backend for the browser E2E suite against its dedicated database:
// guards the target, recreates and migrates the database, seeds the
// deterministic fixtures and then runs the server in the foreground. Neither
// the development database nor the recovery test database of the PostgreSQL
// suites is ever touched: the guards accept only invoiceops_recovery_e2e and
// the URL comes from RECOVERY_E2E_DATABASE_URL.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SIGNAL_EXIT,
  exitOnChildError,
  forceKillAfter,
  launcherExitCode,
} from "./e2e-exit.mjs";
import { e2ePort } from "./e2e-ports.mjs";
import { assertPortFree } from "./port-probe.mjs";
import {
  assertRecoveryTarget,
  expectedDatabasePort,
  e2eDatabaseName,
} from "./recovery-db-guards.mjs";
import { runRecoveryReset } from "./recovery-local-reset.mjs";

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Children run `node --import <guard> --import tsx <script>` (no tsx wrapper
// process in between) with an IPC channel: if this launcher is SIGKILLed the
// channel closes and the child exits by itself (see exit-with-parent.mjs).
// What can not be covered: the detached prisma group of the reset, which is
// short and only killed on normal exits.
const guard = resolve(backendDirectory, "scripts/exit-with-parent.mjs");
const guardedTsx = ["--import", guard, "--import", "tsx"];
const childStdio = ["inherit", "inherit", "inherit", "ipc"];

const startedAt = Date.now();
// stderr: Playwright pipes a webServer's stderr but ignores its stdout.
// Stage names and elapsed milliseconds only: never URLs or credentials.
function stage(message) {
  console.error(`[e2e-backend] +${Date.now() - startedAt}ms ${message}`);
}

// Exit code of the signal that asked this launcher to stop, once one arrived.
let stopping;
// The migrate/seed child while one runs (the reset kills its own process group
// on exit, see spawnWithGroupKill).
let active;

// Registered before any slow step: a signal during the reset, the migrate or
// the seed must stop the child and exit, not leave it running.
for (const [signal, code] of Object.entries(SIGNAL_EXIT)) {
  process.on(signal, () => {
    stopping = code;
    const child = active ?? server;
    if (!child) process.exit(code);
    child.kill(signal);
    // A child that ignores the signal is killed after the grace period.
    forceKillAfter(child);
  });
}

/** Runs a child to completion without blocking the event loop (signals work). */
function run(command, args, options) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, options);
    active = child;
    exitOnChildError(child, {
      label: "child",
      stage,
      getStopping: () => stopping,
      exit: (exitCode) => process.exit(exitCode),
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      active = undefined;
      resolveRun({ code, signal });
    });
  });
}

let server;

async function main() {
  stage("start");
  const url = process.env.RECOVERY_E2E_DATABASE_URL;
  if (!url) {
    throw new Error(
      "RECOVERY_E2E_DATABASE_URL must be configured; the E2E suite never uses the development or recovery test database",
    );
  }
  assertRecoveryTarget(url, {
    confirmReset: e2eDatabaseName,
    allowedNames: [e2eDatabaseName],
    expectedPort: expectedDatabasePort(process.env),
  });
  // The same refusal as the suite's own configuration: this launcher can be
  // started by hand for E2E_REUSE_SERVERS.
  const port = e2ePort("E2E_BACKEND_PORT", 4391);
  await assertPortFree(port);
  await runRecoveryReset({
    argv: [
      "--database-url-env",
      "RECOVERY_E2E_DATABASE_URL",
      `--confirm-reset=${e2eDatabaseName}`,
    ],
    env: process.env,
    allowedNames: [e2eDatabaseName],
    log: (message) =>
      stage(
        String(message).replace(/^reset: target .*/, "reset: target validated"),
      ),
  });
  stage("reset+migrate done");

  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NO_COLOR: "1",
    DATABASE_URL: url,
    // Cookies do not require HTTPS outside production.
    NODE_ENV: "development",
    PORT: String(port),
    // The suite only talks to the backend over loopback.
    HOST: "127.0.0.1",
    // Specs sign in many times from one address.
    AUTH_RATE_LIMIT_DISABLED: "true",
  };
  if (stopping) process.exit(stopping);
  const seeded = await run(process.execPath, [...guardedTsx, "e2e/seed.ts"], {
    cwd: backendDirectory,
    stdio: childStdio,
    env: childEnv,
  });
  if (stopping) process.exit(stopping);
  if (seeded.code !== 0) throw new Error("e2e seed failed");
  stage("seed done");

  server = spawn(process.execPath, [...guardedTsx, "src/server.ts"], {
    cwd: backendDirectory,
    stdio: childStdio,
    env: childEnv,
  });
  exitOnChildError(server, {
    label: "server",
    stage,
    getStopping: () => stopping,
    exit: (exitCode) => process.exit(exitCode),
  });
  stage("server spawned");
  // The signal handlers above forward to the server from here on.
  // Never leave the server behind, whatever ends this launcher.
  process.on("exit", () => server?.kill("SIGKILL"));
  server.on("exit", (code, signal) => {
    stage(`server exited (${signal ?? code})`);
    process.exit(launcherExitCode({ stopping, code, signal }));
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
