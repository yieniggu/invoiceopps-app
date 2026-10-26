export interface RecoveryTarget {
  databaseName: string;
  url: string;
  maintenanceUrl: string;
  sanitized: string;
}

export function assertRecoveryTarget(
  value: string | undefined,
  options: { confirmReset?: string; allowedNames?: string[] },
): RecoveryTarget;

export function sanitizeTarget(value: string): string;

export function parseResetArguments(
  argv: string[],
  env: Record<string, string | undefined>,
): { url: string; confirmReset?: string; envName: string };

export const devDatabaseName: string;
export const testDatabaseName: string;
export const recoveryDatabaseNames: string[];

export function safeDecode(value: string, fallback?: string | null): string;
