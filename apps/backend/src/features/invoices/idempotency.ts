import { createHash } from "node:crypto";

import type { InvoiceCreateRequest } from "./types.js";

/** Bump when the canonical serialization below changes. */
export const INVOICE_CREATE_FINGERPRINT_VERSION = 1;

/** Operation label stored with every create idempotency record. */
export const INVOICE_CREATE_OPERATION = "POST:/api/v1/invoices";

type Fingerprinter = (request: InvoiceCreateRequest) => string;

/**
 * SHA-256 of the normalized create DTO serialized with sorted keys, so field
 * order, surrounding whitespace and an omitted versus null groupId never
 * change it. The owner (user) and scope live in the record key, not here.
 */
function fingerprintV1(request: InvoiceCreateRequest) {
  const canonical = Object.fromEntries(
    Object.entries(request).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Every serialization ever stored; keep old entries when bumping the version. */
const FINGERPRINTERS: ReadonlyMap<number, Fingerprinter> = new Map([
  [1, fingerprintV1],
]);

/** True when a stored record's version can still be recomputed. */
export function isSupportedFingerprintVersion(version: number) {
  return FINGERPRINTERS.has(version);
}

/**
 * Fingerprint under an explicit version (default: the current one). Throws on
 * an unknown version; callers treat that as a mismatch, never as a match.
 */
export function fingerprintInvoiceCreate(
  request: InvoiceCreateRequest,
  version: number = INVOICE_CREATE_FINGERPRINT_VERSION,
) {
  const fingerprinter = FINGERPRINTERS.get(version);
  if (!fingerprinter) {
    throw new RangeError(`Unsupported fingerprint version ${version}`);
  }
  return fingerprinter(request);
}
