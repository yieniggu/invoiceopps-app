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
import { createOrganizationController } from "./controllers.js";
import {
  MembershipCreateRequestSchema,
  MembershipListResponseSchema,
  MembershipParamsSchema,
  MembershipResponseSchema,
  MembershipRoleRequestSchema,
  OrganizationCreateRequestSchema,
  OrganizationCreateResponseSchema,
  OrganizationListResponseSchema,
  OrganizationParamsSchema,
} from "./schemas.js";
import type { OrganizationService } from "./services.js";

const TAG = "Organizations";
const NOT_A_MEMBER =
  "the organization does not exist or the actor is not a member (the platform administrator has no implicit membership)";

export function createOrganizationOperations(
  auth: AuthService | undefined,
  organizations: OrganizationService | undefined,
): Operation[] {
  const controller = createOrganizationController(auth, organizations);

  return [
    {
      method: "get",
      path: "/organizations",
      summary:
        "List organizations (all for the platform administrator, else own)",
      tag: TAG,
      secured: true,
      responses: {
        200: {
          description: "Organizations visible to the actor",
          schema: OrganizationListResponseSchema,
        },
        401: unauthenticatedResponse,
        403: forbiddenResponse("a temporary password is still pending"),
      },
      handler: controller.list,
    },
    {
      method: "post",
      path: "/organizations",
      summary: "Create an organization with its first ADMIN",
      tag: TAG,
      secured: true,
      requestBody: OrganizationCreateRequestSchema,
      responses: {
        201: {
          description:
            "Organization and first ADMIN membership created atomically",
          schema: OrganizationCreateResponseSchema,
        },
        400: validationResponse("invalid or unknown body field"),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "only the platform administrator creates organizations",
        ),
        404: errorResponse(
          "USER_NOT_FOUND: no user has the firstAdminRut; nothing is persisted",
        ),
        409: errorResponse(
          "ORGANIZATION_SLUG_CONFLICT: the slug already exists",
        ),
      },
      handler: controller.create,
    },
    {
      method: "get",
      path: "/organizations/{organizationId}/memberships",
      summary: "List the memberships of an organization",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      responses: {
        200: {
          description: "Memberships with a user summary",
          schema: MembershipListResponseSchema,
        },
        401: unauthenticatedResponse,
        403: forbiddenResponse("only an organization ADMIN lists memberships"),
        404: notFoundResponse(NOT_A_MEMBER),
      },
      handler: controller.listMemberships,
    },
    {
      method: "post",
      path: "/organizations/{organizationId}/memberships",
      summary: "Add an existing user to the organization by RUT",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      requestBody: MembershipCreateRequestSchema,
      responses: {
        201: {
          description:
            "Membership created; the credentials of the user are untouched",
          schema: MembershipResponseSchema,
        },
        400: validationResponse("invalid or unknown body field"),
        401: unauthenticatedResponse,
        403: forbiddenResponse("only an organization ADMIN adds members"),
        404: errorResponse(
          `USER_NOT_FOUND: no user has that RUT; NOT_FOUND: ${NOT_A_MEMBER}`,
        ),
        409: errorResponse(
          "MEMBERSHIP_CONFLICT: the user already belongs to the organization",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.createMembership,
    },
    {
      method: "patch",
      path: "/organizations/{organizationId}/memberships/{userId}",
      summary: "Change the role of a member",
      tag: TAG,
      secured: true,
      params: MembershipParamsSchema,
      requestBody: MembershipRoleRequestSchema,
      responses: {
        200: {
          description: "Updated membership",
          schema: MembershipResponseSchema,
        },
        400: validationResponse("invalid or unknown body field"),
        401: unauthenticatedResponse,
        403: forbiddenResponse("only an organization ADMIN changes roles"),
        404: notFoundResponse(`${NOT_A_MEMBER}, or the target is not a member`),
        409: errorResponse(
          "LAST_ADMIN_REQUIRED: the organization must retain an ADMIN",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.changeMembershipRole,
    },
    {
      method: "delete",
      path: "/organizations/{organizationId}/memberships/{userId}",
      summary:
        "Remove a member and their group memberships in this organization",
      tag: TAG,
      secured: true,
      params: MembershipParamsSchema,
      responses: {
        204: { description: "Membership and its group memberships removed" },
        401: unauthenticatedResponse,
        403: forbiddenResponse("only an organization ADMIN removes members"),
        404: notFoundResponse(`${NOT_A_MEMBER}, or the target is not a member`),
        409: errorResponse(
          "LAST_ADMIN_REQUIRED: the organization must retain an ADMIN",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.removeMembership,
    },
  ];
}
