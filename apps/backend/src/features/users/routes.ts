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
import { OrganizationParamsSchema } from "../orgs/schemas.js";
import { createUserController } from "./controllers.js";
import {
  OrganizationUserListQuerySchema,
  OrganizationUserListResponseSchema,
  UserParamsSchema,
  UserBasicResponseSchema,
  UserProvisionRequestSchema,
  UserProvisionResponseSchema,
} from "./schemas.js";
import type { UserService } from "./services.js";

const TAG = "Users";
const NOT_A_MEMBER =
  "the organization does not exist or the actor is neither a member nor the platform administrator (the platform administrator administers every existing organization but has no implicit membership)";

export function createUserOperations(
  auth: AuthService | undefined,
  users: UserService | undefined,
): Operation[] {
  const controller = createUserController(auth, users);

  return [
    {
      method: "get",
      path: "/organizations/{organizationId}/users",
      summary: "List the users of an organization",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      query: OrganizationUserListQuerySchema,
      responses: {
        200: {
          description:
            "One page of the members of the organization only (optionally those matching search), ordered by name, RUT and id",
          schema: OrganizationUserListResponseSchema,
        },
        400: validationResponse(
          "unknown or repeated query parameter, empty search, search longer than 100 characters or with a NUL character, page outside 1..10000, or pageSize outside 1..100",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "only an organization ADMIN or the platform administrator lists users",
        ),
        404: notFoundResponse(NOT_A_MEMBER),
      },
      handler: controller.list,
    },
    {
      method: "get",
      path: "/users/{userId}",
      summary:
        "Basic view of a user: name, email and the organizations shared with the caller",
      tag: TAG,
      secured: true,
      params: UserParamsSchema,
      responses: {
        200: {
          description:
            "Visible to the platform administrator, to the user itself and to users sharing an organization with the target. Never exposes the RUT, credentials, onboarding state, roles or permissions; a disabled user stays visible with recentlyActive false",
          schema: UserBasicResponseSchema,
        },
        401: unauthenticatedResponse,
        403: forbiddenResponse("a temporary password is still pending"),
        404: notFoundResponse(
          "the user does not exist or shares no organization with the caller (indistinguishable)",
        ),
      },
      handler: controller.get,
    },
    {
      method: "post",
      path: "/organizations/{organizationId}/users",
      summary: "Create a user with a one-time temporary password",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      requestBody: UserProvisionRequestSchema,
      largeBody: true,
      responses: {
        201: {
          description:
            "User and membership created atomically; the temporary password is returned once",
          schema: UserProvisionResponseSchema,
          headers: {
            "Cache-Control": { description: "no-store" },
          },
        },
        400: validationResponse("invalid or unknown body field"),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "only an organization ADMIN or the platform administrator creates users",
        ),
        404: notFoundResponse(NOT_A_MEMBER),
        409: errorResponse(
          "USER_CONFLICT: a user with that RUT already exists",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.provision,
    },
  ];
}
