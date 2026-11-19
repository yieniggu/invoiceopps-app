/**
 * Pure decisions of the bot and of the demo summary: which scope a row asks
 * for, whether an invoice (read from the page or the API) is the one a row describes, and how to
 * keep credentials out of error messages. No I/O, no Playwright.
 */

import { scopeValue } from "./contract.ts";

/** One `<option>` of the scope selector, as read from the page. */
export interface ScopeOption {
  value: string;
  text: string;
  /** Label of its `<optgroup>`, empty when it has none. */
  organization: string;
}

export interface ScopeChoice {
  value: string;
  organizationId: string;
  groupId?: string;
}

export type ScopePick =
  | { kind: "found"; choice: ScopeChoice }
  | { kind: "missing" }
  /** A blank organization while several are offered, or a label shared by several. */
  | { kind: "ambiguous" };

/**
 * The scope option for a row. Organization and group names are Excel data
 * compared with `<optgroup label>` / `<option>` text; everything else is the
 * option `value`. A blank organization is only resolved when exactly one
 * organization is offered: guessing would create the invoice in the wrong one.
 */
export function pickScope(
  options: readonly ScopeOption[],
  organization: string,
  group: string,
): ScopePick {
  const wanted = organization.trim();
  const wantedGroup = group.trim();
  // Distinct organizations that match: all of them when the row names none,
  // those under the wanted label otherwise. Two optgroups with the same label
  // are two organizations; taking the first could create in the wrong one.
  const candidates = new Set(
    options.flatMap((option) => {
      if (wanted !== "" && option.organization !== wanted) return [];
      const parsed = scopeValue.parse(option.value);
      return parsed ? [parsed.organizationId] : [];
    }),
  );
  if (candidates.size > 1) return { kind: "ambiguous" };
  for (const option of options) {
    if (wanted !== "" && option.organization !== wanted) continue;
    const parsed = scopeValue.parse(option.value);
    if (!parsed) continue;
    const choice = { value: option.value, ...parsed };
    if (wantedGroup === "" && parsed.groupId === undefined)
      return { kind: "found", choice };
    if (
      wantedGroup !== "" &&
      parsed.groupId !== undefined &&
      option.text === wantedGroup
    )
      return { kind: "found", choice };
  }
  return { kind: "missing" };
}

/** The facts of an invoice that a reconciliation compares. */
export interface InvoiceFacts {
  businessId: string;
  supplierName: string;
  amountPesos: number;
  issuedOn: string;
  dueOn: string;
  organizationId: string;
  groupId: string | null;
}

/** What an invoice of the API looks like (demo verification only, not the bot). */
export interface ApiInvoice extends InvoiceFacts {
  id: string;
}

/** Names of the `data-*` anchors of an inbox row (docs/rpa-selector-contract.md). */
export type RowAttributes = Readonly<Record<string, string | null | undefined>>;

/**
 * The facts a row exposes in its `data-*` anchors. `undefined` when any anchor
 * is missing or the amount is not plain digits: that is never proof of a match.
 */
export function invoiceFactsFromAttributes(
  read: RowAttributes,
): InvoiceFacts | undefined {
  const businessId = read["data-business-id"];
  const supplierName = read["data-supplier"];
  const amount = read["data-amount-pesos"];
  const issuedOn = read["data-issued-on"];
  const dueOn = read["data-due-on"];
  const organizationId = read["data-organization-id"];
  const groupId = read["data-group-id"];
  if (
    businessId == null ||
    supplierName == null ||
    amount == null ||
    issuedOn == null ||
    dueOn == null ||
    organizationId == null ||
    groupId == null ||
    !PLAIN_AMOUNT.test(amount)
  )
    return undefined;
  const amountPesos = Number(amount);
  if (!Number.isSafeInteger(amountPesos)) return undefined;
  return {
    businessId,
    supplierName,
    amountPesos,
    issuedOn,
    dueOn,
    organizationId,
    groupId: groupId === "" ? null : groupId,
  };
}

/** What a row asks for; `organizationId` / `groupId` left out skip the scope check. */
export interface ExpectedInvoice {
  businessId: string;
  supplierName: string;
  /** The Excel text, as typed: `12500`, `320.000`, `$ 1.234`. */
  amountPesos: string;
  issuedOn: string;
  dueOn: string;
  organizationId?: string;
  /** `null` is the organization scope. */
  groupId?: string | null;
}

const PLAIN_AMOUNT = /^\d+$/;
const GROUPED_AMOUNT = /^[1-9]\d{0,2}(?:\.\d{3})+$/;

/**
 * Whole pesos from the typed amount: digits, or Chilean thousands dots, with an
 * optional leading `$`. Anything else (decimals, signs, text) is `undefined`.
 */
export function amountPesosFromText(text: string): number | undefined {
  const trimmed = text.trim();
  const unsigned = (
    trimmed.startsWith("$") ? trimmed.slice(1) : trimmed
  ).trim();
  if (!PLAIN_AMOUNT.test(unsigned) && !GROUPED_AMOUNT.test(unsigned))
    return undefined;
  const pesos = Number(unsigned.replaceAll(".", ""));
  return Number.isSafeInteger(pesos) ? pesos : undefined;
}

/** Names of the fields in which `item` differs from what the row asked for. */
export function invoiceMismatches(
  expected: ExpectedInvoice,
  item: InvoiceFacts,
): string[] {
  const mismatches: string[] = [];
  if (item.businessId !== expected.businessId) mismatches.push("businessId");
  if (item.supplierName !== expected.supplierName.trim())
    mismatches.push("supplierName");
  if (item.amountPesos !== amountPesosFromText(expected.amountPesos))
    mismatches.push("amountPesos");
  if (item.issuedOn !== expected.issuedOn) mismatches.push("issuedOn");
  if (item.dueOn !== expected.dueOn) mismatches.push("dueOn");
  if (
    expected.organizationId !== undefined &&
    item.organizationId !== expected.organizationId
  )
    mismatches.push("organizationId");
  if (expected.groupId !== undefined && item.groupId !== expected.groupId)
    mismatches.push("groupId");
  return mismatches;
}

const MAX_MESSAGE = 300;

/** First line of an error message with every secret removed, capped in length. */
export function redact(message: string, secrets: readonly string[]): string {
  let text = message.split("\n")[0] ?? "";
  for (const secret of secrets)
    if (secret !== "") text = text.replaceAll(secret, "***");
  return text.length > MAX_MESSAGE
    ? `${text.slice(0, MAX_MESSAGE - 1)}…`
    : text;
}
