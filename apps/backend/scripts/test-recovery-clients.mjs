// Runs the classroom client examples (examples/recovery/*) against the real
// app and the isolated recovery test database. It reuses the PostgreSQL
// runner, so the same target guards, reset and migrations apply, and only the
// `.clients.test.ts` suites are selected.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { runRecoveryPostgresTests } from "./test-recovery-postgres.mjs";

export function runRecoveryClientTests(dependencies = {}) {
  return runRecoveryPostgresTests({
    ...dependencies,
    filter: ".clients.test.ts",
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runRecoveryClientTests().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
