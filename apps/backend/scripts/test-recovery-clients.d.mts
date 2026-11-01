import type { RecoveryPostgresDependencies } from "./test-recovery-postgres.mjs";

export function runRecoveryClientTests(
  dependencies?: Omit<RecoveryPostgresDependencies, "filter">,
): Promise<void>;
