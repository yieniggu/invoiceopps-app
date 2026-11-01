import type { RequestHandler } from "express";

import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import { ApiError, parseWith } from "../../http/errors.js";
import { logEvent, requestFields } from "../../http/logging.js";
import type { AuthService } from "../auth/services.js";
import {
  requireSessionProfile,
  sessionTokenFromCookie,
} from "../auth/session.js";
import {
  ApiTokenCreateRequestSchema,
  ApiTokenListQuerySchema,
  ApiTokenParamsSchema,
} from "./schemas.js";
import type { ApiTokenService } from "./services.js";

/** A route whose backing service is not wired answers like a missing session. */
function wired(service: ApiTokenService | undefined) {
  if (!service) throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
  return service;
}

export function createApiTokenController(
  auth: AuthService | undefined,
  tokens: ApiTokenService | undefined,
  issuanceLimiter: AuthRateLimiter,
) {
  const create: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    // Every attempt of the user counts (accepted or not), reserved
    // synchronously before any await so concurrent requests cannot all pass.
    const limiterKey = `api-token-issuance:${actor.id}`;
    if (issuanceLimiter.isBlocked(limiterKey)) {
      logEvent("warn", "api_token.rate_limited", {
        ...requestFields(request),
        code: "RATE_LIMITED",
        actorUserId: actor.id,
      });
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Too many API token requests; wait before trying again",
      );
    }
    issuanceLimiter.recordFailure(limiterKey);
    const input = parseWith(
      ApiTokenCreateRequestSchema,
      request.body,
      "Invalid API token",
    );
    const service = wired(tokens);
    // requireSessionProfile proved a session cookie is present.
    const sessionToken = sessionTokenFromCookie(request.headers.cookie) ?? "";
    const created = await service.createToken(
      { userId: actor.id, sessionToken },
      input,
    );
    // Audit: identifiers only, never the secret, its hash or the name.
    logEvent("info", "audit.api_token_created", {
      feature: "api-tokens",
      action: "API_TOKEN_CREATED",
      tokenId: created.token.id,
      organizationId: created.token.organizationId,
      ...(created.token.groupId ? { groupId: created.token.groupId } : {}),
      actorUserId: actor.id,
    });
    // The secret is shown once and must not be stored by any cache.
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json(created);
  };

  const list: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const query = parseWith(
      ApiTokenListQuerySchema,
      request.query,
      "Invalid API token query",
    );
    response.status(200).json(await wired(tokens).listTokens(actor.id, query));
  };

  const revoke: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    // A malformed id answers the same generic 404 as a missing token.
    const params = ApiTokenParamsSchema.safeParse(request.params);
    if (!params.success) throw new ApiError(404, "NOT_FOUND", "Not found");
    const { tokenId } = params.data;
    const result = await wired(tokens).revokeToken(actor.id, tokenId);
    // Only the call that revoked the token logs it; a repeat is a no-op.
    if (result.revoked) {
      logEvent("info", "audit.api_token_revoked", {
        feature: "api-tokens",
        action: "API_TOKEN_REVOKED",
        tokenId,
        organizationId: result.organizationId,
        actorUserId: actor.id,
      });
    }
    response.status(204).end();
  };

  return { create, list, revoke };
}
