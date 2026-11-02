// Starts the backend for the browser E2E suite against its dedicated database:
// guards the target, recreates and migrates the database, seeds the
// deterministic fixtures and then runs the server in the foreground. Neither
// the development database nor the recovery test database of the PostgreSQL
// suites is ever touched: the guards accept only invoiceops_recovery_e2e and
// the URL comes from RECOVERY_E2E_DATABASE_URL.

import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { e2ePort } from "./e2e-ports.mjs";
import {
  assertRecoveryTarget,
  expectedDatabasePort,
  e2eDatabaseName,
} from "./recovery-db-guards.mjs";
import { runRecoveryReset } from "./recovery-local-reset.mjs";

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = resolve(backendDirectory, "node_modules/tsx/dist/cli.mjs");

async function main() {
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
  await runRecoveryReset({
    argv: [
      "--database-url-env",
      "RECOVERY_E2E_DATABASE_URL",
      `--confirm-reset=${e2eDatabaseName}`,
    ],
    env: process.env,
    allowedNames: [e2eDatabaseName],
    log: () => {},
  });

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
  const seeded = spawnSync(process.execPath, [tsx, "e2e/seed.ts"], {
    cwd: backendDirectory,
    stdio: "inherit",
    env: childEnv,
  });
  if (seeded.status !== 0) throw new Error("e2e seed failed");

  const server = spawn(process.execPath, [tsx, "src/server.ts"], {
    cwd: backendDirectory,
    stdio: "inherit",
    env: childEnv,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.kill(signal));
  }
  server.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
