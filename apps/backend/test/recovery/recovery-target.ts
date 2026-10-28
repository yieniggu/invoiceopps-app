import {
  assertRecoveryTarget,
  expectedDatabasePort,
  testDatabaseName,
} from "../../scripts/recovery-db-guards.mjs";

/**
 * The URL of the dedicated recovery test database, after the same guards the
 * reset and the runners apply (loopback host, exact database name). Every
 * PostgreSQL suite reads its target through this one function, so a suite can
 * never run against the development database or a remote server.
 */
export function recoveryTestDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const url = env.RECOVERY_TEST_DATABASE_URL;
  if (!url) {
    throw new Error("RECOVERY_TEST_DATABASE_URL must be configured");
  }
  assertRecoveryTarget(url, {
    confirmReset: testDatabaseName,
    allowedNames: [testDatabaseName],
    expectedPort: expectedDatabasePort(env),
  });
  return url;
}
