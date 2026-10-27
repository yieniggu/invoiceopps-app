import type { Response } from "express";

import type { AuthProfile, AuthService } from "./services.js";

export const SESSION_COOKIE_NAME = "invoiceops_session";
export const SESSION_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionTokenFromCookie(header: string | undefined) {
  if (!header) {
    return undefined;
  }

  return header
    .split(";")
    .map((value) => value.trim().split("="))
    .find(([name]) => name === SESSION_COOKIE_NAME)?.[1];
}

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
