import { describe, expect, it } from "vitest";

import { requireTestDatabaseUrl } from "./test-database-url.js";

describe("database integration URL guard", () => {
  it("requires an explicit test database", () => {
    expect(() => requireTestDatabaseUrl(undefined)).toThrow(
      "TEST_DATABASE_URL must be configured for database integration tests",
    );
    expect(() =>
      requireTestDatabaseUrl(
        "postgresql://user:password@localhost:5432/invoiceops",
      ),
    ).toThrow("TEST_DATABASE_URL must target the invoiceops_test database");
  });

  it("allows only PostgreSQL URLs for invoiceops_test", () => {
    expect(
      requireTestDatabaseUrl(
        "postgresql://user:password@localhost:5432/invoiceops_test?schema=public",
      ),
    ).toBe(
      "postgresql://user:password@localhost:5432/invoiceops_test?schema=public",
    );
  });
});
