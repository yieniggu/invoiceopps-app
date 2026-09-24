import { describe, expect, it } from "vitest";

import {
  assertLocalDemonstrationDatabaseUrl,
  assertLocalDemonstrationEnvironment,
} from "../src/local-demonstration.js";

describe("APP-07 local demonstration database guard", () => {
  it("requires an explicit development runtime", () => {
    expect(() =>
      assertLocalDemonstrationEnvironment("development"),
    ).not.toThrow();
    expect(() => assertLocalDemonstrationEnvironment(undefined)).toThrow(
      "LOCAL_DEMONSTRATION requires NODE_ENV=development",
    );
    expect(() => assertLocalDemonstrationEnvironment("production")).toThrow(
      "LOCAL_DEMONSTRATION requires NODE_ENV=development",
    );
  });

  it("accepts only the dedicated local development database endpoints", () => {
    expect(() =>
      assertLocalDemonstrationDatabaseUrl(
        "postgresql://invoiceops:password@localhost:5432/invoiceops?schema=public",
      ),
    ).not.toThrow();
    expect(() =>
      assertLocalDemonstrationDatabaseUrl(
        "postgresql://invoiceops:password@db:5432/invoiceops?schema=public",
      ),
    ).not.toThrow();
  });

  it("refuses non-local and test database targets before writing demonstration data", () => {
    for (const databaseUrl of [
      "postgresql://invoiceops:password@database.example.test:5432/invoiceops?schema=public",
      "postgresql://invoiceops:password@localhost:5432/invoiceops_test?schema=public",
      "postgresql://invoiceops:password@localhost:5432/customer_records?schema=public",
    ]) {
      expect(() => assertLocalDemonstrationDatabaseUrl(databaseUrl)).toThrow(
        "LOCAL_DEMONSTRATION requires the local invoiceops database",
      );
    }
  });
});
