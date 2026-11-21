import type { Request, Response } from "express";

import { ApiError } from "../../http/errors.js";
import type { AuthProfile, AuthService } from "./services.js";

export const SESSION_COOKIE_NAME = "invoiceops_session";
export const SESSION_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The session token of a Cookie header. A request carrying more than one
 * `invoiceops_session` cookie is treated as having none: with a parent-domain
 * cookie a sibling subdomain can toss a second cookie, and "first wins" here
 * versus "last wins" elsewhere (the MLflow gateway) would let the two sides
 * authenticate different sessions. The gateway applies the same rule.
 */
export function sessionTokenFromCookie(header: string | undefined) {
  if (!header) {
    return undefined;
  }

  const values: string[] = [];
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator > 0 && trimmed.slice(0, separator) === SESSION_COOKIE_NAME) {
      values.push(trimmed.slice(separator + 1));
    }
  }

  return values.length === 1 ? values[0] : undefined;
}

/**
 * The session cookie is host-only: no `Domain` attribute, so the browser sends
 * it only to the exact host that set it. MLflow sign-in is a redirect handoff
 * (GET /api/v1/mlflow/authorize), not a shared cookie, and the app and the
 * gateway live on sibling subdomains that must not see each other's session.
 */
const sessionCookieOptions = () => ({
  httpOnly: true,
  path: "/",
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
});

export function setSessionCookie(response: Response, sessionToken: string) {
  response.cookie(SESSION_COOKIE_NAME, sessionToken, {
    ...sessionCookieOptions(),
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
  });
}

export function clearSessionCookie(response: Response) {
  response.clearCookie(SESSION_COOKIE_NAME, sessionCookieOptions());
}

/**
 * Resolves the session profile once per request: the onboarding gate stores it
 * in `response.locals.profile` and handlers reuse it instead of querying again.
 */
export async function loadProfile(
  auth: AuthService,
  sessionToken: string,
  response: Response,
): Promise<AuthProfile> {
  const cached = response.locals.profile as AuthProfile | undefined;
  if (cached) return cached;
  const profile = await auth.getProfile(sessionToken);
  response.locals.profile = profile;
  return profile;
}

/**
 * The authenticated actor of a documented operation. A missing cookie or an
 * unwired auth service answers like a missing session.
 */
export async function requireSessionProfile(
  auth: AuthService | undefined,
  request: Request,
  response: Response,
): Promise<AuthProfile> {
  const sessionToken = sessionTokenFromCookie(request.headers.cookie);
  if (!auth || !sessionToken) {
    throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
  }
  return loadProfile(auth, sessionToken, response);
}
