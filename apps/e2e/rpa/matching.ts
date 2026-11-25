/**
 * Pure decisions of the bot and of the demo summary: which organization and
 * group a row asks for, whether an invoice (read from the page or the API) is the one a row describes, and how to
 * keep credentials out of error messages. No I/O, no Playwright.
 */

import { scopeValue } from "./contract.ts";

/** One `<option>` of the organization or the group select, as read from the page. */
export interface SelectOption {
  /** Organization id (organization select) or scope value (group select). */
  value: string;
  text: string;
}

export interface ScopeChoice {
  value: string;
  organizationId: string;
  groupId?: string;
}

/**
 * Names are not unique in the database: the same name may be offered twice
 * (two organizations, or one group name in two groups). A name that matches
 * more than one option is never resolved by taking the first.
 */
export type NamePick<T> =
  { kind: "found"; choice: T } | { kind: "missing" } | { kind: "ambiguous" };

/**
 * The organization a row asks for, by its exact name (Excel data, not
 * interface copy). A blank name is only resolved when exactly one organization
 * is offered: guessing would create the invoice in the wrong one.
 */
export function pickOrganization(
  options: readonly SelectOption[],
  organization: string,
): NamePick<string> {
  const wanted = organization.trim();
  const matches = options.filter(
    (option) => wanted === "" || option.text === wanted,
  );
  if (matches.length > 1) return { kind: "ambiguous" };
  const [only] = matches;
  return only ? { kind: "found", choice: only.value } : { kind: "missing" };
}

/**
 * The group a row asks for among the options of the chosen organization, by
 * exact name. A blank group is the organization scope (no group assigned).
 */
export function pickGroup(
  options: readonly SelectOption[],
  group: string,
): NamePick<ScopeChoice> {
  const wanted = group.trim();
  const matches = options.flatMap((option) => {
    const parsed = scopeValue.parse(option.value);
    if (!parsed) return [];
    const isOrganization = parsed.groupId === undefined;
    if (wanted === "" ? !isOrganization : isOrganization) return [];
    if (wanted !== "" && option.text !== wanted) return [];
    return [{ value: option.value, ...parsed }];
  });
  if (matches.length > 1) return { kind: "ambiguous" };
  const [only] = matches;
  return only ? { kind: "found", choice: only } : { kind: "missing" };
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
