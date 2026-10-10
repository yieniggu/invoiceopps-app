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

  it("accepts only nonce-matched ephemeral loopback credentials", () => {
    const namespace = "abcdef1234";
    const safe =
      "postgresql://evi_abcdef1234:synthetic@127.0.0.1:5436/invoiceops_test";
    expect(requireTestDatabaseUrl(safe, namespace)).toBe(safe);
    for (const unsafe of [
      "postgresql://invoiceops:synthetic@localhost:5436/invoiceops_test",
      "postgresql://evi_abcdef1234:synthetic@localhost:5436/invoiceops_test",
      "postgresql://evi_deadbeef12:synthetic@127.0.0.1:5436/invoiceops_test",
      `${safe}?schema=public`,
    ]) {
      expect(() => requireTestDatabaseUrl(unsafe, namespace)).toThrow(
        "APP-10 requires a fresh isolated loopback test database",
      );
    }
    expect(() => requireTestDatabaseUrl(safe, "")).toThrow();
  });
});
