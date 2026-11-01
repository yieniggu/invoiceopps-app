import { ApiError } from "../../http/errors.js";
import {
  NO_INVOICE_PERMISSIONS,
  type InvoicePermissions,
} from "../groups/invoice-permissions.js";
import { FLAG_BY_SCOPE, type ApiScope } from "./scopes.js";
import type { ApiTokenContext } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Longest lifetime a token can be issued for (also a database CHECK). */
export const MAX_TOKEN_LIFETIME_MS = 30 * DAY_MS;

/**
 * Logical AND, flag by flag, of the owner's current permissions and the scopes
 * the token carries: a token can narrow its owner but never widen them.
 */
export function restrictPermissionsByToken(
  permissions: InvoicePermissions,
  scopes: readonly ApiScope[],
): InvoicePermissions {
  const restricted: InvoicePermissions = { ...NO_INVOICE_PERMISSIONS };
  for (const scope of scopes) {
    const flag = FLAG_BY_SCOPE[scope];
    restricted[flag] = permissions[flag];
  }
  return restricted;
}

/** A token is expired from its expiresAt instant on (expiresAt <= now). */
export function isTokenExpired(expiresAt: Date, now: Date) {
  return expiresAt.getTime() <= now.getTime();
}

/** An expiry must be strictly in the future and at most 30 days ahead. */
export function validateTokenExpiry(expiresAt: Date, now: Date) {
  const remaining = expiresAt.getTime() - now.getTime();
  return remaining > 0 && remaining <= MAX_TOKEN_LIFETIME_MS;
}

/** 403 for an operation the owner may do but the token does not allow. */
export function insufficientScope() {
  return new ApiError(
    403,
    "INSUFFICIENT_SCOPE",
    "The API token does not allow this operation",
  );
}

/**
 * Applies a token on top of an already authorized owner. `scopeGroupId` is the
 * real group of the operation (null for the organization scope): a group token
 * serves exactly its group, an organization token any scope of its
 * organization. `allows` reads the flag(s) the operation needs. A session
 * request has no token and passes unchanged.
 */
export function assertTokenAllows(
  token: ApiTokenContext | null,
  scopeGroupId: string | null,
  effective: InvoicePermissions,
  allows: (permissions: InvoicePermissions) => boolean,
) {
  if (!token) return;
  if (token.groupId !== null && token.groupId !== scopeGroupId) {
    throw insufficientScope();
  }
  if (!allows(restrictPermissionsByToken(effective, token.scopes))) {
    throw insufficientScope();
  }
}
