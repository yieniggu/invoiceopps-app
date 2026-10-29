import type { Operation } from "../../http/registry.js";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  retryableConflictResponse,
  unauthenticatedResponse,
  validationResponse,
} from "../../http/standard-responses.js";
import type { AuthService } from "../auth/services.js";
import { createAdminUserController } from "./controllers.js";
import {
  AdminUserCreateRequestSchema,
  AdminUserCreateResponseSchema,
  AdminUserDeactivationResponseSchema,
  AdminUserDetailResponseSchema,
  AdminUserListQuerySchema,
  AdminUserListResponseSchema,
  AdminUserParamsSchema,
  AdminUserPasswordResetRequestSchema,
  AdminUserPasswordResetResponseSchema,
  AdminUserUpdateRequestSchema,
  AdminUserUpdateResponseSchema,
} from "./schemas.js";
import type { AdminUserService } from "./services.js";

export function createAdminUserOperations(
  auth: AuthService | undefined,
  adminUsers: AdminUserService | undefined,
): Operation[] {
  const controller = createAdminUserController(auth, adminUsers);

  return [
    {
      method: "get",
      path: "/admin/users",
      summary:
        "List users with a name or RUT search, a status filter and pagination",
      tag: "Admin users",
      secured: true,
      query: AdminUserListQuerySchema,
      responses: {
        200: {
          description:
            "One page of users ordered by name; total counts every match. recentlyActive tells whether the user was active in the last 15 minutes; the exact time is never returned",
          schema: AdminUserListResponseSchema,
        },
        400: validationResponse(
          "unknown or repeated query parameter, empty search, search longer than 120 characters or with a NUL character, unknown status, page outside 1..10000, or pageSize outside 1..100",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse("only the platform administrator lists users"),
      },
      handler: controller.list,
    },
    {
      method: "get",
      path: "/admin/users/{userId}",
      summary:
        "User detail with every organization and group membership and its invoice permissions",
      tag: "Admin users",
      secured: true,
      params: AdminUserParamsSchema,
      responses: {
        200: {
          description:
            "The user and its memberships, ordered by organization name and group name",
          schema: AdminUserDetailResponseSchema,
        },
        401: unauthenticatedResponse,
        403: forbiddenResponse("only the platform administrator reads users"),
        404: notFoundResponse("the user does not exist"),
      },
      handler: controller.detail,
    },
    {
      method: "patch",
      path: "/admin/users/{userId}",
      summary:
        "Change the name or the RUT of a user; a RUT change revokes the user's sessions and API tokens",
      tag: "Admin users",
      secured: true,
      params: AdminUserParamsSchema,
      requestBody: AdminUserUpdateRequestSchema,
      responses: {
        200: {
          description:
            "The updated user (idempotent: repeating the same values writes no audit row)",
          schema: AdminUserUpdateResponseSchema,
        },
        400: validationResponse(
          "invalid or unknown body field, invalid RUT, or none of name and rut sent",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse("only the platform administrator edits users"),
        404: notFoundResponse("the user does not exist"),
        409: errorResponse(
          "USER_CONFLICT: another user already has that RUT; SELF_ACTION_FORBIDDEN: the actor changes their own RUT (their own name may change)",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.update,
    },
    {
      method: "post",
      path: "/admin/users/{userId}/password-reset",
      summary:
        "Reset a user's password to a temporary one: sessions are deleted, API tokens revoked and a change is forced at next login",
      tag: "Admin users",
      secured: true,
      params: AdminUserParamsSchema,
      requestBody: AdminUserPasswordResetRequestSchema,
      responses: {
        200: {
          description:
            "The temporary password is valid until expiresAt; it is returned once and only when the server generated it",
          schema: AdminUserPasswordResetResponseSchema,
          headers: { "Cache-Control": { description: "no-store" } },
        },
        400: validationResponse(
          "invalid or unknown body field, or a temporaryPassword outside 8..256 characters",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "only the platform administrator resets passwords",
        ),
        404: notFoundResponse("the user does not exist"),
        409: errorResponse(
          "SELF_ACTION_FORBIDDEN: the actor targets themselves",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.resetPassword,
    },
    {
      method: "post",
      path: "/admin/users",
      summary:
        "Create a user with a temporary password and memberships in any number of organizations and groups",
      tag: "Admin users",
      secured: true,
      requestBody: AdminUserCreateRequestSchema,
      largeBody: true,
      responses: {
        201: {
          description:
            "User, organization memberships and group memberships created atomically; the temporary password is returned once",
          schema: AdminUserCreateResponseSchema,
          headers: { "Cache-Control": { description: "no-store" } },
        },
        400: validationResponse(
          "invalid or unknown body field, duplicate organizationId or groupId, too many organizations, or more group grants in total than the cap (200 across all memberships)",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "only the platform administrator creates users this way",
        ),
        404: errorResponse(
          "NOT_FOUND: an organization does not exist, or a group does not belong to its organization; nothing is persisted",
        ),
        409: errorResponse(
          "USER_CONFLICT: a user with that RUT already exists; nothing is persisted",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.create,
    },
    {
      method: "post",
      path: "/admin/users/{userId}/deactivation",
      summary:
        "Deactivate a user: sessions are deleted, API tokens revoked and login refused until reactivation",
      tag: "Admin users",
      secured: true,
      params: AdminUserParamsSchema,
      responses: {
        200: {
          description:
            "The user is deactivated (idempotent: repeating returns the stored disabledAt without a new audit row)",
          schema: AdminUserDeactivationResponseSchema,
        },
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "only the platform administrator deactivates users",
        ),
        404: notFoundResponse("the user does not exist"),
        409: errorResponse(
          "SELF_ACTION_FORBIDDEN: the actor targets themselves; LAST_ADMIN_REQUIRED: the user is the last enabled ADMIN of an organization",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.deactivate,
    },
    {
      method: "delete",
      path: "/admin/users/{userId}/deactivation",
      summary:
        "Reactivate a user; sessions deleted at deactivation are not restored",
      tag: "Admin users",
      secured: true,
      params: AdminUserParamsSchema,
      responses: {
        200: {
          description:
            "The user is enabled (idempotent: repeating writes no audit row)",
          schema: AdminUserDeactivationResponseSchema,
        },
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "only the platform administrator reactivates users",
        ),
        404: notFoundResponse("the user does not exist"),
        409: errorResponse(
          "SELF_ACTION_FORBIDDEN: the actor targets themselves",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.reactivate,
    },
  ];
}
