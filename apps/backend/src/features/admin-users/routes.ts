import type { Operation } from "../../http/registry.js";
import {
  errorResponse,
  forbiddenResponse,
  retryableConflictResponse,
  unauthenticatedResponse,
  validationResponse,
} from "../../http/standard-responses.js";
import type { AuthService } from "../auth/services.js";
import { createAdminUserController } from "./controllers.js";
import {
  AdminUserCreateRequestSchema,
  AdminUserCreateResponseSchema,
} from "./schemas.js";
import type { AdminUserService } from "./services.js";

export function createAdminUserOperations(
  auth: AuthService | undefined,
  adminUsers: AdminUserService | undefined,
): Operation[] {
  const controller = createAdminUserController(auth, adminUsers);

  return [
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
  ];
}
