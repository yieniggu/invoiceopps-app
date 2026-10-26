export interface ResetClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: object[] }>;
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
  ) => {
    status: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  };
  log?: (message: string) => void;
}

export function runRecoveryReset(
  dependencies?: ResetDependencies,
): Promise<{ databaseName: string; url: string }>;
