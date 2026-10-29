import { describe, expect, it } from "vitest";

import {
  fingerprintInvoiceCreate,
  INVOICE_CREATE_FINGERPRINT_VERSION,
  isSupportedFingerprintVersion,
} from "../../src/features/invoices/idempotency.js";
import { matchesStoredFingerprint } from "../../src/features/invoices/services.js";
import { InvoiceCreateRequestSchema } from "../../src/features/invoices/schemas.js";

const VALID = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  groupId: "22222222-2222-4222-8222-222222222222",
  businessId: "FAC-2026-001",
  supplierName: "Proveedor local",
  amountPesos: 12500,
  currency: "CLP",
  issuedOn: "2026-10-25",
  dueOn: "2026-11-25",
  businessStatus: "PENDING",
};
const OTHER_GROUP_ID = "55555555-5555-4555-8555-555555555555";

function withoutGroup(): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...VALID };
  delete copy.groupId;
  return copy;
}

function fingerprintOf(body: unknown): string {
  return fingerprintInvoiceCreate(InvoiceCreateRequestSchema.parse(body));
}

describe("fingerprintInvoiceCreate (AC-07, AC-08, AC-09)", () => {
  it("is versioned", () => {
    expect(INVOICE_CREATE_FINGERPRINT_VERSION).toBe(1);
  });

  it("is a SHA-256 hex digest", () => {
    expect(fingerprintOf(VALID)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on the order of the body fields", () => {
    const reversed = Object.fromEntries(Object.entries(VALID).reverse());
    expect(fingerprintOf(reversed)).toBe(fingerprintOf(VALID));
  });

  it("hashes the normalized DTO, so surrounding whitespace is irrelevant", () => {
    expect(fingerprintOf({ ...VALID, businessId: "  FAC-2026-001 " })).toBe(
      fingerprintOf(VALID),
    );
  });

  it("treats an omitted groupId and a null groupId as the same scope", () => {
    expect(fingerprintOf(withoutGroup())).toBe(
      fingerprintOf({ ...VALID, groupId: null }),
    );
  });

  it("distinguishes the organization scope from a group and groups from each other", () => {
    const organization = fingerprintOf(withoutGroup());
    const group = fingerprintOf(VALID);
    const otherGroup = fingerprintOf({ ...VALID, groupId: OTHER_GROUP_ID });
    expect(new Set([organization, group, otherGroup]).size).toBe(3);
  });

  it.each([
    ["amountPesos", 12501],
    ["supplierName", "Otro proveedor"],
    ["businessId", "FAC-2026-002"],
    ["issuedOn", "2026-10-24"],
    ["dueOn", "2026-11-26"],
    ["businessStatus", "APPROVED"],
  ] as const)("changes when %s changes", (field, value) => {
    expect(fingerprintOf({ ...VALID, [field]: value })).not.toBe(
      fingerprintOf(VALID),
    );
  });
});

describe("versioned fingerprints (CR-323)", () => {
  const request = InvoiceCreateRequestSchema.parse(VALID);

  it("defaults to the current version and accepts it explicitly", () => {
    expect(
      fingerprintInvoiceCreate(request, INVOICE_CREATE_FINGERPRINT_VERSION),
    ).toBe(fingerprintInvoiceCreate(request));
  });

  it("rejects an unknown version instead of guessing", () => {
    expect(isSupportedFingerprintVersion(1)).toBe(true);
    expect(isSupportedFingerprintVersion(2)).toBe(false);
    expect(() => fingerprintInvoiceCreate(request, 2)).toThrow(RangeError);
  });

  it("matches a stored record by recomputing with its own version", () => {
    const stored = { fingerprint: fingerprintInvoiceCreate(request, 1) };
    expect(
      matchesStoredFingerprint(request, { ...stored, fingerprintVersion: 1 }),
    ).toBe(true);
    expect(
      matchesStoredFingerprint(
        { ...request, amountPesos: 1 },
        { ...stored, fingerprintVersion: 1 },
      ),
    ).toBe(false);
  });

  it("treats a stored record of an unknown version as a mismatch", () => {
    const fingerprint = fingerprintInvoiceCreate(request);
    expect(
      matchesStoredFingerprint(request, { fingerprint, fingerprintVersion: 2 }),
    ).toBe(false);
  });
});
