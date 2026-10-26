export interface MigrationLedgerRow {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

export function expectedMigrationChecksums(
  directory: string,
  names: string[],
): Pick<MigrationLedgerRow, "migration_name" | "checksum">[];

export function assertMigrationLedger(
  rows: MigrationLedgerRow[],
  expected: Pick<MigrationLedgerRow, "migration_name" | "checksum">[],
): void;

export interface GateDependencies {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  spawn?: (
    binary: string,
    args: readonly string[],
    options: {
      encoding: string;
      timeout: number;
      maxBuffer?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => { status: number | null; stdout: string; stderr: string; error?: Error };
  Client?: new (options: {
    connectionString: string;
    connectionTimeoutMillis: number;
  }) => {
    connect(): Promise<void>;
    end(): Promise<void>;
    query(sql: string, values?: unknown[]): Promise<{ rows: object[] }>;
  };
  log?: (message: string) => void;
}

export function runIntegrationGate(
  dependencies?: GateDependencies,
): Promise<void>;
