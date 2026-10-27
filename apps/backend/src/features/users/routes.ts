import type { Operation } from "../../http/registry.js";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  unauthenticatedResponse,
  validationResponse,
} from "../../http/standard-responses.js";
import type { AuthService } from "../auth/services.js";
import { OrganizationParamsSchema } from "../orgs/schemas.js";
import { createUserController } from "./controllers.js";
import {
  OrganizationUserListResponseSchema,
  UserProvisionRequestSchema,
  UserProvisionResponseSchema,
} from "./schemas.js";
import type { UserService } from "./services.js";

const TAG = "Users";
const NOT_A_MEMBER =
  "the organization does not exist or the actor is not a member (the platform administrator has no implicit membership)";

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
      responses: {
        200: {
          description: "Members of the organization only",
          schema: OrganizationUserListResponseSchema,
        },
        401: unauthenticatedResponse,
        403: forbiddenResponse("only an organization ADMIN lists users"),
        404: notFoundResponse(NOT_A_MEMBER),
      },
      handler: controller.list,
    },
    {
      method: "post",
      path: "/organizations/{organizationId}/users",
      summary: "Create a user with a one-time temporary password",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      requestBody: UserProvisionRequestSchema,
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
        403: forbiddenResponse("only an organization ADMIN creates users"),
        404: notFoundResponse(NOT_A_MEMBER),
        409: errorResponse(
          "USER_CONFLICT: a user with that RUT already exists",
        ),
      },
      handler: controller.provision,
    },
  ];
}
