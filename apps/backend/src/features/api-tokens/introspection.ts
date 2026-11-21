import { createHash, timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";
import { z } from "zod";

import type { PrismaClient } from "../../generated/prisma/client.js";
import {
  createAuthRateLimiter,
  type AuthRateLimiter,
} from "../../auth-rate-limit.js";
import { ApiError, parseWith, sendError } from "../../http/errors.js";
import { logEvent } from "../../http/logging.js";
import { isTokenExpired } from "./authorization.js";
import {
  MAX_SERVICE_SECRET_LENGTH,
  MIN_SERVICE_SECRET_LENGTH,
  validatedServiceSecret,
} from "../../service-secret.js";
import { hasMlflowAccess } from "./mlflow-access.js";
import { hashTokenSecret } from "./secret.js";
import { fromStoredScopes, isMlflowScope, type MlflowScope } from "./scopes.js";

/** Path of the private introspection endpoint; never part of the public API. */
export const INTROSPECTION_PATH = "/internal/api-tokens/introspect";

export { MAX_SERVICE_SECRET_LENGTH, MIN_SERVICE_SECRET_LENGTH };

/**
 * Startup validation of INTERNAL_INTROSPECTION_SECRET. Unset or empty keeps the
 * documented fail-closed mode (the private routes refuse every request); a
 * value that is set but too short, too long, containing whitespace or not
 * randomly generated (see service-secret.ts) is a configuration mistake, so the
 * process refuses to start. The message never contains the value.
 */
export function internalServiceSecretFromEnv(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  return validatedServiceSecret("INTERNAL_INTROSPECTION_SECRET", value);
}

/** How long the gateway may cache a positive answer. */
export const ACTIVE_CACHE_TTL_SECONDS = 30;
/** How long the gateway may cache a negative answer. */
export const INACTIVE_CACHE_TTL_SECONDS = 5;

/** `lastUsedAt` is rewritten at most once per this interval per token. */
export const LAST_USED_THROTTLE_MS = 60_000;

export const IntrospectRequestSchema = z.object({
  token: z.string().min(1).max(512),
});

export type IntrospectResult =
  | {
      active: true;
      userId: string;
      organizationId: string;
      groupId: string | null;
      scopes: MlflowScope[];
      cacheTtlSeconds: number;
    }
  | { active: false; cacheTtlSeconds: number };

const INACTIVE: IntrospectResult = {
  active: false,
  cacheTtlSeconds: INACTIVE_CACHE_TTL_SECONDS,
};

export interface ApiTokenIntrospectionService {
  /**
   * Resolves a raw token. Active only when the hash matches, the token is not
   * revoked or expired, it carries at least one MLflow scope and its owner is
   * still an active member of its organization (and group). Every other case
   * is the same `{ active: false }`: the reason is never disclosed.
   */
  introspect(secret: string): Promise<IntrospectResult>;
}

export function createApiTokenIntrospectionService(
  prisma: PrismaClient,
  now: () => Date = () => new Date(),
): ApiTokenIntrospectionService {
  /** Fire and forget: the answer never waits for, or fails on, this write. */
  function touchLastUsed(tokenId: string, at: Date) {
    void prisma.apiToken
      .updateMany({
        where: {
          id: tokenId,
          OR: [
            { lastUsedAt: null },
            {
              lastUsedAt: {
                lt: new Date(at.getTime() - LAST_USED_THROTTLE_MS),
              },
            },
          ],
        },
        data: { lastUsedAt: at },
      })
      .catch((error: unknown) => {
        logEvent("warn", "api_token.last_used_failed", {
          feature: "api-tokens",
          tokenId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      });
  }

  return {
    async introspect(secret) {
      const row = await prisma.apiToken.findUnique({
        where: { tokenHash: hashTokenSecret(secret) },
        select: {
          id: true,
          userId: true,
          organizationId: true,
          groupId: true,
          scopes: true,
          expiresAt: true,
          revokedAt: true,
        },
      });
      const at = now();
      if (!row || row.revokedAt || isTokenExpired(row.expiresAt, at)) {
        return INACTIVE;
      }
      const scopes = fromStoredScopes(row.scopes).filter(isMlflowScope);
      if (scopes.length === 0) return INACTIVE;
      const allowed = await hasMlflowAccess(prisma, {
        userId: row.userId,
        organizationId: row.organizationId,
        groupId: row.groupId,
      });
      if (!allowed) return INACTIVE;
      touchLastUsed(row.id, at);
      return {
        active: true,
        userId: row.userId,
        organizationId: row.organizationId,
        groupId: row.groupId,
        scopes,
        cacheTtlSeconds: ACTIVE_CACHE_TTL_SECONDS,
      };
    },
  };
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Wrong service credentials tolerated per client IP within the window. */
export const SERVICE_GUARD_MAX_FAILURES = 20;
export const SERVICE_GUARD_WINDOW_MS = 60_000;

/**
 * Service-to-service guard: `Authorization: Bearer <INTERNAL_INTROSPECTION_SECRET>`.
 * Compared in constant time over fixed-length digests. A missing, blank or
 * too short configured secret fails closed (every request is refused). A user
 * session cookie or a user API token never matches, so neither can reach the
 * endpoint.
 *
 * Every 401 counts against the caller's IP (`request.ip`; with the public
 * proxy not forwarding /internal, the callers are containers of the private
 * network). The credential is compared first and a valid one always passes:
 * it neither consumes budget nor is blocked, so a spoofed X-Forwarded-For
 * cannot lock the real service out. Past SERVICE_GUARD_MAX_FAILURES wrong
 * credentials within the window, further wrong attempts from that IP get
 * `429` (with `Retry-After`), which bounds guessing and log noise.
 */
export function createServiceCredentialGuard(
  secret: string | undefined,
  limiter: AuthRateLimiter = createAuthRateLimiter({
    maxAttempts: SERVICE_GUARD_MAX_FAILURES,
    windowMs: SERVICE_GUARD_WINDOW_MS,
  }),
): RequestHandler {
  const expected =
    secret !== undefined && secret.length >= MIN_SERVICE_SECRET_LENGTH
      ? digest(secret)
      : undefined;
  return (request, response, next) => {
    const presented = /^Bearer ([^\s]{1,512})$/i.exec(
      request.headers.authorization ?? "",
    )?.[1];
    // Always hash something so the work done does not depend on the header.
    const matches = timingSafeEqual(
      digest(presented ?? ""),
      expected ?? digest(""),
    );
    // Compare first: a valid credential always passes, so a client that spoofs
    // X-Forwarded-For to share the gateway's IP cannot lock the gateway out.
    if (expected !== undefined && presented !== undefined && matches) {
      next();
      return;
    }
    const key = `internal:ip:${request.ip ?? "unknown"}`;
    if (limiter.isBlocked(key)) {
      logEvent("warn", "internal.rate_limited", {
        code: "RATE_LIMITED",
        scope: "ip",
      });
      response.set("Retry-After", String(SERVICE_GUARD_WINDOW_MS / 1000));
      sendError(
        response,
        429,
        "RATE_LIMITED",
        "Too many failed attempts; wait before trying again",
      );
      return;
    }
    limiter.recordFailure(key);
    response.set("WWW-Authenticate", "Bearer");
    sendError(response, 401, "UNAUTHENTICATED", "Unauthenticated");
    return;
  };
}

export function createIntrospectionHandler(
  service: ApiTokenIntrospectionService | undefined,
): RequestHandler {
  return async (request, response) => {
    if (!service) throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
    const { token } = parseWith(
      IntrospectRequestSchema,
      request.body,
      "Invalid introspection request",
    );
    const result = await service.introspect(token);
    response.setHeader(
      "Cache-Control",
      `private, max-age=${result.cacheTtlSeconds}`,
    );
    response.status(200).json(result);
  };
}
