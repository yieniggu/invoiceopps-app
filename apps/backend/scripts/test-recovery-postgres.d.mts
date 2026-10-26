export interface RecoveryPostgresDependencies {
  env?: Record<string, string | undefined>;
  spawn?: (
    binary: string,
    args: readonly string[],
    options: object,
  ) => { status: number | null };
  reset?: (dependencies: object) => Promise<unknown>;
  log?: (message: string) => void;
}

export function runRecoveryPostgresTests(
  dependencies?: RecoveryPostgresDependencies,
): Promise<void>;
