import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertRecoveryTarget,
  testDatabaseName as testDatabase,
} from "./recovery-db-guards.mjs";
import { runRecoveryReset } from "./recovery-local-reset.mjs";

const backendDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function runRecoveryPostgresTests({
  env = process.env,
  spawn = spawnSync,
  reset = runRecoveryReset,
  log = console.info,
} = {}) {
  const url = env.RECOVERY_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "RECOVERY_TEST_DATABASE_URL must be configured; PostgreSQL tests never skip",
    );
  }
  // Same guards as the reset; the runner supplies the confirmation itself
  // because it only ever targets the dedicated test database.
  assertRecoveryTarget(url, {
    confirmReset: testDatabase,
    allowedNames: [testDatabase],
  });
  await reset({
    argv: [
      "--database-url-env",
      "RECOVERY_TEST_DATABASE_URL",
      `--confirm-reset=${testDatabase}`,
    ],
    env,
    allowedNames: [testDatabase],
    log,
  });
  const childEnv = {
    PATH: env.PATH,
    HOME: env.HOME,
    NO_COLOR: "1",
    RECOVERY_TEST_DATABASE_URL: url,
  };
  const generated = spawn("pnpm", ["exec", "prisma", "generate"], {
    cwd: backendDirectory,
    stdio: "inherit",
    env: { ...childEnv, DATABASE_URL: url },
  });
  if (generated.status !== 0) throw new Error("prisma generate failed");
  const tests = spawn(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      ".postgres.test.ts",
      "--testTimeout",
      "30000",
      // The files share one test database (singleton administrator, truncated
      // tables): they must never run at the same time.
      "--no-file-parallelism",
    ],
    { cwd: backendDirectory, stdio: "inherit", env: childEnv },
  );
  if (tests.status !== 0) {
    throw new Error(`recovery PostgreSQL tests failed (exit ${tests.status})`);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runRecoveryPostgresTests().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
