export interface ResetClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: object[] }>;
}

export interface SpawnResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

export interface ResetDependencies {
  argv?: string[];
  env?: Record<string, string | undefined>;
  allowedNames?: string[];
  createClient?: (
    connectionString: string,
  ) => ResetClient | Promise<ResetClient>;
  spawn?: (
    binary: string,
    args: readonly string[],
    options: object,
  ) => SpawnResult | Promise<SpawnResult>;
  log?: (message: string) => void;
}

export function runRecoveryReset(
  dependencies?: ResetDependencies,
): Promise<{ databaseName: string; url: string }>;

export interface GroupKillOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
  spawnImpl?: typeof import("node:child_process").spawn;
  platform?: NodeJS.Platform;
  killGroup?: (pid: number) => void;
}

export function spawnWithGroupKill(
  command: string,
  args: readonly string[],
  options?: GroupKillOptions,
): Promise<SpawnResult>;

export const prismaBin: string;
