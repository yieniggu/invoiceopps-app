import { ErrorResponseSchema } from "./errors.js";
import type { OperationResponse } from "./registry.js";

const ERROR = ErrorResponseSchema;

/** Error responses shared by every session-protected operation. */
export const unauthenticatedResponse: OperationResponse = {
  description: "UNAUTHENTICATED: missing, invalid or expired session",
  schema: ERROR,
};

export const forbiddenResponse = (description: string): OperationResponse => ({
  description: `FORBIDDEN: ${description}; FORBIDDEN_ORIGIN: a write carrying a session cookie came from another origin; ONBOARDING_REQUIRED: a temporary password is still pending`,
  schema: ERROR,
});

export const validationResponse = (description: string): OperationResponse => ({
  description: `VALIDATION_ERROR: ${description}; INVALID_JSON: the body is not valid JSON; AMBIGUOUS_AUTH: an Authorization header and a session cookie were both sent`,
  schema: ERROR,
});

export const notFoundResponse = (description: string): OperationResponse => ({
  description: `NOT_FOUND: ${description}`,
  schema: ERROR,
});

/** Any other error status; the description starts with the public code. */
export const errorResponse = (description: string): OperationResponse => ({
  description,
  schema: ERROR,
});

/** Serializable retries exhausted (runSerializable); safe to repeat the request. */
export const retryableConflictResponse: OperationResponse = {
  description:
    "RETRYABLE_CONFLICT: the change conflicted with concurrent writes and was not applied; repeat the request after Retry-After seconds",
  schema: ERROR,
  headers: {
    "Retry-After": { description: "Seconds to wait before retrying" },
  },
};

/** Read variant of the 503: a snapshot read that timed out or lost its race. */
export const retryableReadConflictResponse: OperationResponse = {
  description:
    "RETRYABLE_CONFLICT: the read timed out or conflicted with concurrent writes; nothing was changed, repeat the request after Retry-After seconds",
  schema: ERROR,
  headers: {
    "Retry-After": { description: "Seconds to wait before retrying" },
  },
};

/** 401 of an operation that also accepts an API token (Bearer). */
export const bearerUnauthenticatedResponse: OperationResponse = {
  description:
    "UNAUTHENTICATED: missing, invalid or expired session, or an API token that is malformed, unknown, expired or revoked, or whose owner is disabled; Bearer answers carry WWW-Authenticate: Bearer",
  schema: ERROR,
};

/**
 * 403 of an operation that also accepts an API token: the usual denials plus
 * INSUFFICIENT_SCOPE, the owner may do it but the token does not allow it.
 */
export const bearerForbiddenResponse = (
  description: string,
): OperationResponse => ({
  description: `FORBIDDEN: ${description}; FORBIDDEN_ORIGIN: a write carrying a session cookie came from another origin; ONBOARDING_REQUIRED: a temporary password is still pending; INSUFFICIENT_SCOPE: the request used an API token and the owner is allowed, but the token's scopes or group do not cover this operation (a group token serves only its group; the token never widens its owner's permissions)`,
  schema: ERROR,
});
