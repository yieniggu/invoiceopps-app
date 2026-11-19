/**
 * The selector contract of docs/rpa-selector-contract.md, as constants.
 *
 * Everything the bot locates or decides on lives here: element ids (which are
 * also their `data-testid`), screen markers, state values and the `data-*`
 * attributes. Nothing in this folder may match on Spanish copy or CSS classes.
 */

/** Element identifiers: `id` and `data-testid` carry the same value. */
export const ids = {
  loginForm: "login-form",
  loginRut: "login-rut",
  loginPassword: "login-password",
  loginSubmit: "login-submit",
  loginError: "login-error",
  invoiceForm: "invoice-create-form",
  scope: "invoice-create-scope",
  businessId: "invoice-create-business-id",
  supplierName: "invoice-create-supplier-name",
  amount: "invoice-create-amount",
  businessStatus: "invoice-create-business-status",
  issuedOn: "invoice-create-issued-on",
  dueOn: "invoice-create-due-on",
  submit: "invoice-create-submit",
  failure: "invoice-create-failure",
  retry: "invoice-create-retry",
  /** Informational: a bot does not depend on it; it waits on `data-state`. */
  retrying: "invoice-create-retrying",
  sending: "invoice-create-sending",
  /** Listed so nobody wires it by mistake: a bot NEVER presses it. */
  confirmNew: "invoice-create-confirm-new",
  forbidden: "invoice-create-forbidden",
  created: "invoice-create-created",
  another: "invoice-create-another",
  invoicesTable: "invoices-table",
  invoicesRow: "invoices-row",
  invoicesResults: "invoices-results",
} as const;

export const screens = {
  auth: "auth",
  onboarding: "onboarding",
  invoices: "invoices",
  invoiceCreate: "invoice-create",
  /** Session shell while the profile loads. */
  loading: "loading",
  /** Session shell when the profile could not be loaded. */
  sessionError: "session-error",
} as const;

export const attrs = {
  screen: "data-screen",
  state: "data-state",
  authReason: "data-auth-reason",
  errorKind: "data-error-kind",
  failureKind: "data-failure-kind",
  errorStatus: "data-error-status",
  errorCode: "data-error-code",
  field: "data-field",
  invoiceId: "data-invoice-id",
  businessId: "data-business-id",
  // Facts of an inbox row (raw values, see docs/rpa-selector-contract.md §3).
  organizationId: "data-organization-id",
  groupId: "data-group-id",
  supplier: "data-supplier",
  amountPesos: "data-amount-pesos",
  issuedOn: "data-issued-on",
  dueOn: "data-due-on",
} as const;

/** Every `data-*` an inbox row carries for reconciliation. */
export const rowFactAttributes = [
  attrs.businessId,
  attrs.organizationId,
  attrs.groupId,
  attrs.supplier,
  attrs.amountPesos,
  attrs.issuedOn,
  attrs.dueOn,
] as const;

/** `data-state` of `invoices-results`: whether the inbox page is settled. */
export const resultsStates = {
  loading: "loading",
  ready: "ready",
  error: "error",
} as const;

/** `data-error-kind` of `invoices-results` (only with `data-state="error"`). */
export const resultsErrorKinds = {
  invalidRange: "invalid-range",
} as const;

export const failureKinds = {
  uncertain: "uncertain",
  burned: "burned",
  rejected: "rejected",
} as const;

export const loginErrorKinds = {
  credentials: "credentials",
  forbidden: "forbidden",
  rateLimited: "rate-limited",
  network: "network",
  unknown: "unknown",
} as const;

/** API code the UI reports when a business id already exists. */
export const BUSINESS_ID_CONFLICT = "BUSINESS_ID_CONFLICT";

/**
 * `value` as the body of a double-quoted CSS string (what `CSS.escape` does for
 * identifiers, here for attribute values): backslash and quote are escaped,
 * control characters become hex escapes and NUL becomes U+FFFD.
 */
export function cssString(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (code === 0) out += "\uFFFD";
    else if (char === "\\" || char === '"') out += `\\${char}`;
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(16)} `;
    else out += char;
  }
  return out;
}

export const css = {
  screen: (screen: string) => `[${attrs.screen}="${screen}"]`,
  screenInState: (screen: string, state: string) =>
    `[${attrs.screen}="${screen}"][${attrs.state}="${state}"]`,
  testId: (id: string) => `[data-testid="${id}"]`,
  fieldError: (fieldId: string) => `#${fieldId}-error`,
  invoiceRow: (businessId: string) =>
    `[data-testid="${ids.invoicesRow}"][${attrs.businessId}="${cssString(businessId)}"]`,
} as const;

/** Value prefixes of the scope `<option>`s (`organization:<org>`, `group:<org>:<grp>`). */
export const scopeValue = {
  organization: (organizationId: string) => `organization:${organizationId}`,
  group: (organizationId: string, groupId: string) =>
    `group:${organizationId}:${groupId}`,
  parse: (
    value: string,
  ): { organizationId: string; groupId?: string } | undefined => {
    const [kind, organizationId, groupId] = value.split(":");
    if (kind === "organization" && organizationId) return { organizationId };
    if (kind === "group" && organizationId && groupId)
      return { organizationId, groupId };
    return undefined;
  },
};

/** Inbox URL query for a scope (`organizationId`, `groupId`, `q`). */
export function inboxPath(
  scope: { organizationId: string; groupId?: string },
  businessId: string,
): string {
  const query = new URLSearchParams({ organizationId: scope.organizationId });
  if (scope.groupId) query.set("groupId", scope.groupId);
  query.set("q", businessId);
  return `/invoices?${query}`;
}

export const paths = {
  root: "/",
  newInvoice: "/invoices/new",
} as const;
