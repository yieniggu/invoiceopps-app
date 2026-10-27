import type { RequestHandler } from "express";

import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import { parseRut } from "../../rut.js";
import { ApiError, parseWith, sendError } from "../../http/errors.js";
import { logEvent, requestFields } from "../../http/logging.js";
import { AuthError, type AuthProfile, type AuthService } from "./services.js";
import { LoginRequestSchema, PasswordChangeRequestSchema } from "./schemas.js";
import {
  clearSessionCookie,
  loadProfile,
  sessionTokenFromCookie,
  setSessionCookie,
} from "./session.js";
import type { AuthProfileDto } from "./types.js";

const UNKNOWN_CLIENT_IP = "unknown";

/** Explicit DTO: never spreads the service profile into the response. */
export function toAuthProfileDto(profile: AuthProfile): AuthProfileDto {
  return {
    id: profile.id,
    name: profile.name,
    rut: profile.rut,
    email: profile.email,
    username: profile.username,
    mustChangePassword: profile.mustChangePassword ?? false,
    isPlatformAdministrator: profile.isPlatformAdministrator,
    memberships: profile.memberships.map((membership) => ({
      organization: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
      },
      role: membership.role,
    })),
    contexts: (profile.contexts ?? []).map((context) => ({
      organizationId: context.organizationId,
      organizationName: context.organizationName,
      groupId: context.groupId,
      groupName: context.groupName,
      capabilities: {
        readInvoices: context.capabilities.readInvoices,
        createInvoices: context.capabilities.createInvoices,
        deleteOwnInvoices: context.capabilities.deleteOwnInvoices,
        deleteOthersInvoices: context.capabilities.deleteOthersInvoices,
      },
    })),
  };
}

export function profileResponse(profile: AuthProfile) {
  return { profile: toAuthProfileDto(profile) };
}

function rutKey(rut: string) {
  try {
    return [{ scope: "rut", key: `rut:${parseRut(rut)}` }];
  } catch {
    // Malformed RUTs are limited by IP only.
    return [];
  }
}

function requireSession(auth: AuthService | undefined, cookie?: string) {
  const sessionToken = sessionTokenFromCookie(cookie);
  if (!auth || !sessionToken) {
    throw new AuthError(401, "Unauthenticated");
  }
  return { auth, sessionToken };
}

/**
 * Login is limited per client IP (request.ip; "trust proxy" is off unless
 * AUTH_TRUST_PROXY_HOPS is set) and per normalized RUT. The RUT key uses a
 * progressive lockout (1 minute first, doubling up to the window, cleared by a
 * successful login); the IP key uses the fixed window.
 *
 * Attempts are reserved synchronously before any credential check, so
 * concurrent requests cannot all slip past the limit while scrypt runs. The
 * reservation is kept only for credential failures: success and non-credential
 * failures (5xx) give it back, so only failed credentials consume budget.
 */
export function createAuthController(
  auth: AuthService | undefined,
  limiter: AuthRateLimiter,
) {
  const login: RequestHandler = async (request, response) => {
    if (!auth) {
      throw new ApiError(503, "SERVICE_UNAVAILABLE", "Service unavailable");
    }

    // A missing or malformed body is just another failed login.
    const credentials = LoginRequestSchema.safeParse(request.body);
    const keys = [
      { scope: "ip", key: `ip:${request.ip ?? UNKNOWN_CLIENT_IP}` },
      ...(credentials.success ? rutKey(credentials.data.rut) : []),
    ];
    const blocked = keys.find(({ key }) => limiter.isBlocked(key));
    if (blocked) {
      logEvent("warn", "auth.rate_limited", {
        ...requestFields(request),
        code: "RATE_LIMITED",
        scope: blocked.scope,
      });
      sendError(
        response,
        429,
        "RATE_LIMITED",
        "Too many attempts; wait before trying again",
      );
      return;
    }

    // Check and reservation share one synchronous section (no await between).
    for (const { scope, key } of keys) {
      limiter.recordFailure(key, { progressive: scope === "rut" });
    }
    let reserved = true;
    const release = (succeeded: boolean) => {
      if (!reserved) return;
      reserved = false;
      for (const { scope, key } of keys) {
        if (succeeded && scope === "rut") limiter.reset(key);
        else limiter.refund(key);
      }
    };

    try {
      if (!credentials.success) {
        throw new AuthError(401, "Invalid credentials");
      }
      const { sessionToken, user } = await auth.login(credentials.data);
      release(true);
      setSessionCookie(response, sessionToken);
      response.status(200).json({
        user: { id: user.id, name: user.name, rut: user.rut },
      });
    } catch (error) {
      if (error instanceof AuthError && error.status === 401) {
        // Never log the RUT, the password or the submitted body.
        logEvent("warn", "auth.login_failed", {
          ...requestFields(request),
          code: "UNAUTHENTICATED",
          reason: credentials.success
            ? "invalid_credentials"
            : "malformed_request",
        });
      } else {
        release(false);
      }
      throw error;
    }
  };

  const profile: RequestHandler = async (request, response) => {
    const session = requireSession(auth, request.headers.cookie);
    response
      .status(200)
      .json(
        profileResponse(
          await loadProfile(session.auth, session.sessionToken, response),
        ),
      );
  };

  const changePassword: RequestHandler = async (request, response) => {
    const { sessionToken } = requireSession(auth, request.headers.cookie);
    if (!auth?.changePassword) {
      throw new AuthError(401, "Unauthenticated");
    }

    const rotated = await auth.changePassword(
      sessionToken,
      parseWith(
        PasswordChangeRequestSchema,
        request.body,
        "Invalid password change",
      ),
    );
    if (rotated) setSessionCookie(response, rotated.sessionToken);
    logEvent("info", "auth.password_changed", requestFields(request));
    response.status(204).end();
  };

  const logout: RequestHandler = async (request, response) => {
    const session = requireSession(auth, request.headers.cookie);
    await session.auth.logout(session.sessionToken);
    clearSessionCookie(response);
    response.status(204).end();
  };

  return { login, profile, changePassword, logout };
}
