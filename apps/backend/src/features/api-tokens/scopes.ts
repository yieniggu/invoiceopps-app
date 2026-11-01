import type { ApiTokenScope } from "../../generated/prisma/client.js";
import type { InvoicePermissions } from "../groups/invoice-permissions.js";

/** Public scope names, in the order the API documents them. */
export const API_SCOPES = [
  "invoices:read",
  "invoices:create",
  "invoices:delete-own",
  "invoices:delete-others",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Each scope maps to exactly one invoice permission flag. */
export const FLAG_BY_SCOPE = {
  "invoices:read": "readInvoices",
  "invoices:create": "createInvoices",
  "invoices:delete-own": "deleteOwnInvoices",
  "invoices:delete-others": "deleteOthersInvoices",
} as const satisfies Record<ApiScope, keyof InvoicePermissions>;

const STORED_BY_SCOPE = {
  "invoices:read": "INVOICES_READ",
  "invoices:create": "INVOICES_CREATE",
  "invoices:delete-own": "INVOICES_DELETE_OWN",
  "invoices:delete-others": "INVOICES_DELETE_OTHERS",
} as const satisfies Record<ApiScope, ApiTokenScope>;

const SCOPE_BY_STORED = Object.fromEntries(
  Object.entries(STORED_BY_SCOPE).map(([scope, stored]) => [stored, scope]),
) as Record<ApiTokenScope, ApiScope>;

export const toStoredScopes = (scopes: readonly ApiScope[]) =>
  scopes.map((scope) => STORED_BY_SCOPE[scope]);

export const fromStoredScopes = (stored: readonly ApiTokenScope[]) =>
  stored.map((scope) => SCOPE_BY_STORED[scope]);
