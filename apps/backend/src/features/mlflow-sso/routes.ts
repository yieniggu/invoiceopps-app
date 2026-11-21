import type { RequestHandler } from "express";
import { z } from "zod";

import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import { ApiError, parseWith } from "../../http/errors.js";
import type { Operation } from "../../http/registry.js";
import {
  errorResponse,
  validationResponse,
} from "../../http/standard-responses.js";
import { hashSessionToken } from "../auth/services.js";
import { sessionTokenFromCookie } from "../auth/session.js";
import type { MlflowSsoService } from "./service.js";

/** Path of the browser authorize endpoint, relative to API_PREFIX. */
export const AUTHORIZE_PATH = "/mlflow/authorize";

const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const AuthorizeQuerySchema = z.object({
  redirect_uri: z
    .string()
    .describe("Exactly the configured gateway callback (MLFLOW_PUBLIC_URL)"),
  state: z
    .string()
    .describe("Opaque value (16-128 base64url characters) echoed back"),
});

/**
 * Browser leg of the MLflow handoff. The redirect target is never taken from
 * the request: `redirect_uri` is only compared (exactly) with the configured
 * callback, and any mismatch is a 400 that redirects nowhere.
 */
/**
 * Authorize requests allowed per validated session per minute; requests
 * without a valid session share the client IP's budget of the same size.
 */
export const AUTHORIZE_MAX_PER_MINUTE = 30;
export const AUTHORIZE_WINDOW_MS = 60_000;

export function createAuthorizeHandler(
  service: MlflowSsoService | undefined,
  callbackUrl: string | undefined,
  limiter?: AuthRateLimiter,
): RequestHandler {
  return async (request, response) => {
    if (!service || !callbackUrl) {
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "MLflow sign-in is not configured",
      );
    }
    const { redirect_uri: redirectUri, state } = request.query;
    if (typeof redirectUri !== "string" || redirectUri !== callbackUrl) {
      throw new ApiError(400, "VALIDATION_ERROR", "Invalid redirect_uri", {
        redirect_uri: "Does not match the configured callback",
      });
    }
    if (typeof state !== "string" || !STATE_PATTERN.test(state)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Invalid state", {
        state: "Expected 16-128 base64url characters",
      });
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");

    const sessionToken = sessionTokenFromCookie(request.headers.cookie);
    // Two buckets. The IP bucket only counts requests whose session turned out
    // invalid (or absent), so an attacker cannot mint a fresh bucket per
    // request by sending random cookie values. The session bucket (hashed,
    // never the token) only exists for a session that validated; every
    // attempt counts, reserved before any await so concurrent requests cannot
    // all pass the check.
    const ipKey = `mlflow-authorize:ip:${request.ip ?? "unknown"}`;
    const sessionKey = sessionToken
      ? `mlflow-authorize:s:${hashSessionToken(sessionToken)}`
      : undefined;
    if (limiter) {
      if (
        limiter.isBlocked(ipKey) ||
        (sessionKey !== undefined && limiter.isBlocked(sessionKey))
      ) {
        response.setHeader(
          "Retry-After",
          String(Math.ceil(AUTHORIZE_WINDOW_MS / 1000)),
        );
        throw new ApiError(
          429,
          "RATE_LIMITED",
          "Too many MLflow sign-in attempts; wait before trying again",
        );
      }
      limiter.recordFailure(sessionKey ?? ipKey);
    }
    const result = sessionToken
      ? await service.authorize(sessionToken)
      : ({ status: "unauthenticated" } as const);
    if (
      limiter &&
      sessionKey !== undefined &&
      result.status === "unauthenticated"
    ) {
      // Not a validated session: the attempt belongs to the client's IP.
      limiter.refund(sessionKey);
      limiter.recordFailure(ipKey);
    }
    if (result.status === "unauthenticated") {
      // The SPA has no return-to-login mechanism: the user signs in at "/" and
      // opens MLflow again (the gateway restarts the handoff).
      response.redirect(302, "/");
      return;
    }
    if (result.status === "no_access") {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "MLflow is not available for this account",
      );
    }
    const target = new URL(callbackUrl);
    target.searchParams.set("code", result.code);
    target.searchParams.set("state", state);
    response.redirect(302, target.toString());
  };
}

export function createMlflowSsoOperations(
  service: MlflowSsoService | undefined,
  callbackUrl: string | undefined,
  limiter?: AuthRateLimiter,
): Operation[] {
  return [
    {
      method: "get",
      path: AUTHORIZE_PATH,
      summary:
        "Browser leg of the MLflow sign-in handoff: redirects to the gateway callback with a single-use code (session cookie)",
      tag: "MLflow",
      secured: true,
      query: AuthorizeQuerySchema,
      responses: {
        302: {
          description:
            "With a valid session: redirect to the configured callback with `code` (single use, 60 s) and the echoed `state`. Without a valid session: redirect to `/` to sign in",
          headers: {
            Location: { description: "Callback URL or the sign-in page" },
            "Cache-Control": { description: "no-store" },
          },
        },
        400: validationResponse(
          "redirect_uri is not exactly the configured callback (nothing is redirected), or state is malformed",
        ),
        403: errorResponse(
          "FORBIDDEN: the account has no context where MLflow may be used",
        ),
        429: errorResponse(
          `RATE_LIMITED: more than ${AUTHORIZE_MAX_PER_MINUTE} authorize requests by this session in one minute`,
        ),
        503: errorResponse(
          "SERVICE_UNAVAILABLE: MLFLOW_PUBLIC_URL is not configured",
        ),
      },
      handler: createAuthorizeHandler(service, callbackUrl, limiter),
    },
  ];
}

const ExchangeRequestSchema = z.object({ code: z.string().min(1).max(512) });
const RevokeRequestSchema = z.object({
  sessionToken: z.string().min(1).max(512),
});

/** Path of the private code exchange used by the gateway. */
export const EXCHANGE_PATH = "/internal/sessions/exchange";
/** Path of the private child-session revocation used by the gateway logout. */
export const REVOKE_PATH = "/internal/sessions/revoke";

export function createExchangeHandler(
  service: MlflowSsoService | undefined,
): RequestHandler {
  return async (request, response) => {
    if (!service) throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
    const { code } = parseWith(
      ExchangeRequestSchema,
      request.body,
      "Invalid exchange request",
    );
    const result = await service.exchange(code);
    response.setHeader("Cache-Control", "no-store");
    // Every failure (unknown, replayed, expired, parent gone) is the same answer.
    response
      .status(200)
      .json(result ? { active: true, ...result } : { active: false });
  };
}

export function createRevokeHandler(
  service: MlflowSsoService | undefined,
): RequestHandler {
  return async (request, response) => {
    if (!service) throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
    const { sessionToken } = parseWith(
      RevokeRequestSchema,
      request.body,
      "Invalid revoke request",
    );
    await service.revoke(sessionToken);
    response.setHeader("Cache-Control", "no-store");
    response.status(204).end();
  };
}
