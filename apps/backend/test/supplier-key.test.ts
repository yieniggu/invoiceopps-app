import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { supplierKey } from "../src/supplier-key.js";

// Keep in sync with invoiceops-ml/tests/fixtures/supplier_key_vectors.json
// (byte-identical copy; the Python implementation is asserted against it too).
const fixtureBytes = readFileSync(
  new URL("./fixtures/supplier_key_vectors.json", import.meta.url),
);
// Pinned so a drifted copy fails here (repos are checked out independently in
// CI). Update together with invoiceops-ml when the vectors change.
const FIXTURE_SHA256 =
  "5c8f517c91dc773c29d359ae1e4a86b485be8cc321caab673e6511442d74d843";
const vectors = JSON.parse(fixtureBytes.toString("utf8")) as Array<{
  name: string;
  input: string;
  expected: string;
}>;

describe("supplierKey", () => {
  it("uses the pinned shared fixture", () => {
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
      FIXTURE_SHA256,
    );
  });

  it("has a wide enough shared vector set", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(30);
  });

  it.each(vectors.map((v) => [v.name, v] as const))(
    "matches the Python implementation: %s",
    (_name, vector) => {
      expect(supplierKey(vector.input)).toBe(vector.expected);
    },
  );

  it("is idempotent", () => {
    for (const vector of vectors) {
      expect(supplierKey(vector.expected)).toBe(vector.expected);
    }
  });
});
