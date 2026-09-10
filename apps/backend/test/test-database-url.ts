const testDatabaseName = "invoiceops_test";

export function requireTestDatabaseUrl(value: string | undefined): string {
  if (!value) {
    throw new Error(
      "TEST_DATABASE_URL must be configured for database integration tests",
    );
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "TEST_DATABASE_URL must be a PostgreSQL URL for invoiceops_test",
    );
  }

  if (
    (url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
    url.pathname !== `/${testDatabaseName}`
  ) {
    throw new Error(
      "TEST_DATABASE_URL must target the invoiceops_test database",
    );
  }

  return value;
}
