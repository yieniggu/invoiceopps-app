import type { Operation } from "../../http/registry.js";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  retryableConflictResponse,
  unauthenticatedResponse,
  validationResponse,
} from "../../http/standard-responses.js";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import type { AuthService } from "../auth/services.js";
import { createApiTokenController } from "./controllers.js";
import {
  ApiTokenCreatedResponseSchema,
  ApiTokenCreateRequestSchema,
  ApiTokenListQuerySchema,
  ApiTokenPageSchema,
  ApiTokenParamsSchema,
} from "./schemas.js";
import {
  MAX_ACTIVE_TOKENS_PER_ORGANIZATION,
  TOKEN_ISSUANCE_MAX_PER_WINDOW,
  type ApiTokenService,
} from "./services.js";

const TAG = "API tokens";

export function createApiTokenOperations(
  auth: AuthService | undefined,
  tokens: ApiTokenService | undefined,
  issuanceLimiter: AuthRateLimiter,
): Operation[] {
  const controller = createApiTokenController(auth, tokens, issuanceLimiter);

  return [
    {
      method: "post",
      path: "/api-tokens",
      summary:
        "Emit an operational API token for an organization or one of its groups (session only)",
      tag: TAG,
      secured: true,
      requestBody: ApiTokenCreateRequestSchema,
      responses: {
        201: {
          description:
            "Token created. The secret (iop_ prefix) is returned only here; only its hash is stored",
          schema: ApiTokenCreatedResponseSchema,
          headers: {
            "Cache-Control": { description: "no-store" },
          },
        },
        400: validationResponse(
          "invalid or unknown body field, unknown or repeated scope, or expiresAt that is not in the future or is more than 30 days ahead",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "a requested scope exceeds the caller's current rights in the token's scope: invoices:* scopes need the matching invoice permission (organization flags for an organization token; organization OR group flags for a group token); mlflow:read and mlflow:write need an active membership of the organization (and of the group for a group token), whatever the invoice flags. An API token (Bearer) cannot call this operation",
        ),
        404: notFoundResponse(
          "the organization does not exist or the caller is not a member (the platform administrator has no implicit membership), or the group does not belong to the organization; all answer the same body",
        ),
        409: errorResponse(
          `TOKEN_LIMIT: the caller already holds ${MAX_ACTIVE_TOKENS_PER_ORGANIZATION} active (not revoked, not expired) tokens in this organization; revoke one first`,
        ),
        429: errorResponse(
          `RATE_LIMITED: more than ${TOKEN_ISSUANCE_MAX_PER_WINDOW} emission attempts by this user in 15 minutes`,
        ),
        503: retryableConflictResponse,
      },
      handler: controller.create,
    },
    {
      method: "get",
      path: "/api-tokens",
      summary:
        "List the caller's own API tokens of an organization or group, revoked ones included (session only)",
      tag: TAG,
      secured: true,
      query: ApiTokenListQuerySchema,
      responses: {
        200: {
          description:
            "One page of token metadata ordered by createdAt descending then id; total counts every match. Never a secret or its hash",
          schema: ApiTokenPageSchema,
        },
        400: validationResponse(
          "missing or malformed organizationId, malformed groupId, unknown query parameter, page outside 1..10000 or pageSize outside 1..100",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse("a temporary password is still pending"),
      },
      handler: controller.list,
    },
    {
      method: "delete",
      path: "/api-tokens/{tokenId}",
      summary:
        "Revoke one of the caller's own API tokens, idempotently (session only)",
      tag: TAG,
      secured: true,
      params: ApiTokenParamsSchema,
      responses: {
        204: {
          description:
            "Token revoked, or already revoked by an earlier request: repeating the request changes nothing",
        },
        401: unauthenticatedResponse,
        403: forbiddenResponse("a temporary password is still pending"),
        404: notFoundResponse(
          "the token does not exist, belongs to another user or the tokenId is not a uuid; all answer the same body",
        ),
      },
      handler: controller.revoke,
    },
  ];
}
