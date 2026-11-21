import type { ApiTokenScope } from "../../generated/prisma/client.js";
import type { InvoicePermissions } from "../groups/invoice-permissions.js";

/** Public scope names, in the order the API documents them. */
export const INVOICE_SCOPES = [
  "invoices:read",
  "invoices:create",
  "invoices:delete-own",
  "invoices:delete-others",
] as const;

/**
 * MLflow scopes. They are not backed by an invoice permission flag: any active
 * member of the token's organization (and of its group, for a group token) may
 * hold them; see `hasMlflowAccess`.
 */
export const MLFLOW_SCOPES = ["mlflow:read", "mlflow:write"] as const;

export const API_SCOPES = [...INVOICE_SCOPES, ...MLFLOW_SCOPES] as const;

export type InvoiceScope = (typeof INVOICE_SCOPES)[number];
export type MlflowScope = (typeof MLFLOW_SCOPES)[number];
export type ApiScope = InvoiceScope | MlflowScope;

export const isMlflowScope = (scope: ApiScope): scope is MlflowScope =>
  (MLFLOW_SCOPES as readonly string[]).includes(scope);

export const isInvoiceScope = (scope: ApiScope): scope is InvoiceScope =>
  !isMlflowScope(scope);

/** Each invoice scope maps to exactly one invoice permission flag. */
export const FLAG_BY_SCOPE = {
  "invoices:read": "readInvoices",
  "invoices:create": "createInvoices",
  "invoices:delete-own": "deleteOwnInvoices",
  "invoices:delete-others": "deleteOthersInvoices",
} as const satisfies Record<InvoiceScope, keyof InvoicePermissions>;

const STORED_BY_SCOPE = {
  "invoices:read": "INVOICES_READ",
  "invoices:create": "INVOICES_CREATE",
  "invoices:delete-own": "INVOICES_DELETE_OWN",
  "invoices:delete-others": "INVOICES_DELETE_OTHERS",
  "mlflow:read": "MLFLOW_READ",
  "mlflow:write": "MLFLOW_WRITE",
} as const satisfies Record<ApiScope, ApiTokenScope>;

const SCOPE_BY_STORED = Object.fromEntries(
  Object.entries(STORED_BY_SCOPE).map(([scope, stored]) => [stored, scope]),
) as Record<ApiTokenScope, ApiScope>;

export const toStoredScopes = (scopes: readonly ApiScope[]) =>
  scopes.map((scope) => STORED_BY_SCOPE[scope]);

export const fromStoredScopes = (stored: readonly ApiTokenScope[]) =>
  stored.map((scope) => SCOPE_BY_STORED[scope]);
