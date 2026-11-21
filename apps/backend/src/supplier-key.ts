/**
 * Canonical supplier identity. Twin of `invoiceops_ml.contract.supplier_key`
 * (invoiceops-ml repository): NFKC normalize, lowercase (no locale), split on an
 * EXPLICIT whitespace set (exactly Python's `str.isspace()`), join with one space.
 *
 * MUST stay in sync with the Python function: both are asserted against
 * `test/fixtures/supplier_key_vectors.json`, a copy (pinned by sha256 in `test/supplier-key.test.ts`) of
 * `invoiceops-ml/tests/fixtures/supplier_key_vectors.json`. Do not use `\s` or
 * `trim()` here: their whitespace sets differ from Python's.
 */
const WHITESPACE_CLASS =
  "\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const NON_WHITESPACE_RUN = new RegExp(`[^${WHITESPACE_CLASS}]+`, "gu");

export function supplierKey(name: string): string {
  const runs = name.normalize("NFKC").toLowerCase().match(NON_WHITESPACE_RUN);
  return runs ? runs.join(" ") : "";
}
