const testDatabaseName = "invoiceops_test";

export function requireTestDatabaseUrl(
  value: string | undefined,
  namespace: string | undefined = process.env.APP10_TEST_NAMESPACE,
): string {
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

  if (
    url.hostname !== "127.0.0.1" ||
    !/^evi_[a-f0-9]{10}$/.test(url.username) ||
    !/^[a-f0-9]{10}$/.test(namespace ?? "") ||
    url.username !== `evi_${namespace}` ||
    !url.port ||
    !url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("APP-10 requires a fresh isolated loopback test database");
  }

  return value;
}
