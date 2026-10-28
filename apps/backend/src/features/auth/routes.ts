import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import { ErrorResponseSchema } from "../../http/errors.js";
import type { Operation } from "../../http/registry.js";
import { createAuthController } from "./controllers.js";
import {
  LoginRequestSchema,
  LoginResponseSchema,
  PasswordChangeRequestSchema,
  ProfileResponseSchema,
  ProfileUpdateSchema,
} from "./schemas.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./password-policy.js";
import type { AuthService } from "./services.js";

const ERROR = ErrorResponseSchema;
const SET_COOKIE = {
  "Set-Cookie": {
    description: "HttpOnly invoiceops_session cookie (SameSite=Lax, Path=/)",
  },
};
const AMBIGUOUS =
  "AMBIGUOUS_AUTH: an Authorization header and a session cookie were both sent";
const INVALID_JSON =
  "INVALID_JSON: the body is not valid JSON; BAD_REQUEST: the body could not be read (for example a corrupt compressed body or a malformed URL escape)";

export { profileResponse } from "./controllers.js";

export function createAuthOperations(
  auth: AuthService | undefined,
  authRateLimiter: AuthRateLimiter,
): Operation[] {
  const controller = createAuthController(auth, authRateLimiter);
  const unauthenticated = {
    description:
      "UNAUTHENTICATED: missing, invalid or expired session (Bearer is not accepted yet)",
    schema: ERROR,
  };
  const forbiddenOrigin = {
    description:
      "FORBIDDEN_ORIGIN: a write carrying a session cookie came from another origin",
    schema: ERROR,
  };

  return [
    {
      method: "post",
      path: "/auth/login",
      summary: "Log in with RUT and password",
      tag: "Auth",
      secured: false,
      requestBody: LoginRequestSchema,
      responses: {
        200: {
          description: "Session started; the session cookie is set",
          schema: LoginResponseSchema,
          headers: SET_COOKIE,
        },
        400: { description: `${INVALID_JSON}; ${AMBIGUOUS}`, schema: ERROR },
        401: {
          description:
            "UNAUTHENTICATED: invalid credentials (an invalid or oversized body is also a failed login), or an Authorization header without a cookie",
          schema: ERROR,
        },
        403: forbiddenOrigin,
        429: {
          description:
            "RATE_LIMITED: too many failed attempts for this client IP or RUT (per-RUT locks grow progressively)",
          schema: ERROR,
        },
        503: {
          description:
            "SERVICE_UNAVAILABLE: authentication is not configured on this server",
          schema: ERROR,
        },
      },
      handler: controller.login,
    },
    {
      method: "get",
      path: "/auth/profile",
      summary:
        "Read the authenticated profile with memberships, groups and invoice permissions",
      tag: "Auth",
      secured: true,
      responses: {
        200: { description: "Profile", schema: ProfileResponseSchema },
        400: { description: `${INVALID_JSON}; ${AMBIGUOUS}`, schema: ERROR },
        401: unauthenticated,
      },
      handler: controller.profile,
    },
    {
      method: "patch",
      path: "/profile",
      summary: "Update the email and username of the authenticated profile",
      tag: "Auth",
      secured: true,
      requestBody: ProfileUpdateSchema,
      responses: {
        200: { description: "Updated profile", schema: ProfileResponseSchema },
        400: {
          description: `VALIDATION_ERROR: unknown field or an empty body; ${INVALID_JSON}; ${AMBIGUOUS}`,
          schema: ERROR,
        },
        401: unauthenticated,
        403: forbiddenOrigin,
      },
      handler: controller.updateProfile,
    },
    {
      method: "post",
      path: "/auth/change-password",
      summary: "Change the password and rotate the session",
      tag: "Auth",
      secured: true,
      requestBody: PasswordChangeRequestSchema,
      responses: {
        204: {
          description:
            "Password changed; every session and API token was revoked and a new session cookie is set",
          headers: SET_COOKIE,
        },
        400: {
          description: `VALIDATION_ERROR: invalid body (newPassword must have ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters); PASSWORD_REUSE: the new password equals the current one; ${INVALID_JSON}; ${AMBIGUOUS}`,
          schema: ERROR,
        },
        401: unauthenticated,
        403: forbiddenOrigin,
      },
      handler: controller.changePassword,
    },
    {
      method: "post",
      path: "/auth/logout",
      summary: "End the current session",
      tag: "Auth",
      secured: true,
      responses: {
        204: {
          description: "Session ended; the cookie is cleared",
          headers: {
            "Set-Cookie": {
              description: "Expires the invoiceops_session cookie",
            },
          },
        },
        400: { description: `${INVALID_JSON}; ${AMBIGUOUS}`, schema: ERROR },
        401: unauthenticated,
        403: forbiddenOrigin,
      },
      handler: controller.logout,
    },
  ];
}
