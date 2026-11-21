export const API_TOKEN_SCOPES = [
  "invoices:read",
  "invoices:create",
  "invoices:delete-own",
  "invoices:delete-others",
  "mlflow:read",
  "mlflow:write",
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/** Token metadata as the API lists it: never the secret nor its hash. */
export interface ApiToken {
  id: string;
  name: string;
  organizationId: string;
  groupId: string | null;
  scopes: ApiTokenScope[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface ApiTokenPage {
  items: ApiToken[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ApiTokenInput {
  name: string;
  organizationId: string;
  groupId?: string;
  scopes: ApiTokenScope[];
  expiresAt: string;
}

/** What an emission hands to the one dialog that shows it. */
export interface IssuedApiToken {
  token: ApiToken;
  secret: string;
}
