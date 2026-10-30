import type { Operation } from "../../http/registry.js";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  retryableConflictResponse,
  retryableReadConflictResponse,
  unauthenticatedResponse,
  validationResponse,
} from "../../http/standard-responses.js";
import type { AuthService } from "../auth/services.js";
import {
  BulkPermissionsUpdateRequestSchema,
  PermissionsUpdateRequestSchema,
} from "../groups/permissions-schema.js";
import { PaginationQuerySchema } from "../../pagination.js";
import { createOrganizationController } from "./controllers.js";
import {
  MembershipCreateRequestSchema,
  MembershipListQuerySchema,
  MembershipListResponseSchema,
  MembershipParamsSchema,
  MembershipResponseSchema,
  MembershipsResponseSchema,
  MembershipRoleRequestSchema,
  OrganizationCreateRequestSchema,
  OrganizationCreateResponseSchema,
  OrganizationDetailResponseSchema,
  OrganizationListQuerySchema,
  OrganizationListResponseSchema,
  OrganizationMemberListResponseSchema,
  OrganizationParamsSchema,
  OrganizationUpdateRequestSchema,
  OrganizationUpdateResponseSchema,
} from "./schemas.js";
import type { OrganizationService } from "./services.js";

const TAG = "Organizations";
const NOT_A_MEMBER =
  "the organization does not exist or the actor is neither a member nor the platform administrator (the platform administrator administers every existing organization but has no implicit membership)";

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
        "List organizations (all for the platform administrator, else own), with a name search and pagination",
      tag: TAG,
      secured: true,
      query: OrganizationListQuerySchema,
      responses: {
        200: {
          description:
            "One page of the organizations visible to the actor ordered by name; total counts every match",
          schema: OrganizationListResponseSchema,
        },
        400: validationResponse(
          "unknown or repeated query parameter, empty search, search longer than 120 characters or with a NUL character, page outside 1..10000, or pageSize outside 1..100",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse("a temporary password is still pending"),
        503: retryableReadConflictResponse,
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
      path: "/organizations/{organizationId}",
      summary: "Get an organization with its member and group counts",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      responses: {
        200: {
          description:
            "Organization summary: any member, or the platform administrator, reads it",
          schema: OrganizationDetailResponseSchema,
        },
        401: unauthenticatedResponse,
        403: forbiddenResponse("a temporary password is still pending"),
        404: notFoundResponse(NOT_A_MEMBER),
        503: retryableReadConflictResponse,
      },
      handler: controller.get,
    },
    {
      method: "patch",
      path: "/organizations/{organizationId}",
      summary: "Update the name or description of an organization",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      requestBody: OrganizationUpdateRequestSchema,
      responses: {
        200: {
          description:
            "Updated organization; a request that changes nothing answers 200 without an audit event",
          schema: OrganizationUpdateResponseSchema,
        },
        400: validationResponse(
          "no field, a blank name, an over-long field, or an unknown field such as slug (immutable)",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "only an organization ADMIN or the platform administrator updates an organization",
        ),
        404: notFoundResponse(NOT_A_MEMBER),
        503: retryableConflictResponse,
      },
      handler: controller.update,
    },
    {
      method: "get",
      path: "/organizations/{organizationId}/members",
      summary: "List the members of an organization (reduced view)",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      query: PaginationQuerySchema,
      responses: {
        200: {
          description:
            "One page of members ordered by name: name, email and whether each was active in the last 15 minutes (never active for a disabled user). Any member, whatever the role, reads it",
          schema: OrganizationMemberListResponseSchema,
        },
        400: validationResponse(
          "unknown or repeated query parameter, page outside 1..10000, or pageSize outside 1..100",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse("a temporary password is still pending"),
        404: notFoundResponse(NOT_A_MEMBER),
        503: retryableReadConflictResponse,
      },
      handler: controller.listMembers,
    },
    {
      method: "get",
      path: "/organizations/{organizationId}/memberships",
      summary: "List the memberships of an organization",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      query: MembershipListQuerySchema,
      responses: {
        200: {
          description:
            "One page of memberships with a user summary (disabled, recentlyActive), their invoice permissions and the groups of each member; total counts every membership, or only those of the requested userIds",
          schema: MembershipListResponseSchema,
        },
        400: validationResponse(
          "unknown or repeated query parameter, page outside 1..10000, pageSize outside 1..100, or userIds empty, over 200, with duplicates or non-UUID values",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "only an organization ADMIN or the platform administrator lists memberships",
        ),
        404: notFoundResponse(NOT_A_MEMBER),
        503: retryableReadConflictResponse,
      },
      handler: controller.listMemberships,
    },
    {
      method: "post",
      path: "/organizations/{organizationId}/memberships",
      summary:
        "Add an existing user to the organization by RUT, with optional invoice permissions",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      requestBody: MembershipCreateRequestSchema,
      responses: {
        201: {
          description:
            "Membership created (permissions default to all false); the credentials of the user are untouched",
          schema: MembershipResponseSchema,
        },
        400: validationResponse("invalid or unknown body field"),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "only an organization ADMIN or the platform administrator adds members",
        ),
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
      summary: "Change the role of a member (permissions are rejected here)",
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
        403: forbiddenResponse(
          "only an organization ADMIN or the platform administrator changes roles",
        ),
        404: notFoundResponse(`${NOT_A_MEMBER}, or the target is not a member`),
        409: errorResponse(
          "LAST_ADMIN_REQUIRED: the organization must retain an ADMIN",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.changeMembershipRole,
    },
    {
      method: "put",
      path: "/organizations/{organizationId}/memberships/{userId}/permissions",
      summary:
        "Replace the four invoice permissions of an organization membership",
      tag: TAG,
      secured: true,
      params: MembershipParamsSchema,
      requestBody: PermissionsUpdateRequestSchema,
      responses: {
        200: {
          description:
            "Permissions replaced atomically; they apply from the next request of that user",
          schema: MembershipResponseSchema,
        },
        400: validationResponse(
          "a flag is missing or not a boolean, or a field is unknown; nothing is persisted",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "only an organization ADMIN or the platform administrator changes permissions",
        ),
        404: notFoundResponse(`${NOT_A_MEMBER}, or the target is not a member`),
        503: retryableConflictResponse,
      },
      handler: controller.updateMembershipPermissions,
    },
    {
      method: "put",
      path: "/organizations/{organizationId}/memberships/permissions",
      summary:
        "Replace the four invoice permissions of several organization memberships at once",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      requestBody: BulkPermissionsUpdateRequestSchema,
      largeBody: true,
      responses: {
        200: {
          description:
            "Permissions of every listed member replaced atomically (all or nothing), in request order",
          schema: MembershipsResponseSchema,
        },
        400: validationResponse(
          "userIds is empty, over 200, has duplicates or non-UUID values, a flag is missing, or a field is unknown; nothing is persisted",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "only an organization ADMIN or the platform administrator changes permissions",
        ),
        404: notFoundResponse(
          `${NOT_A_MEMBER}, or any listed user is not a member (nothing is persisted)`,
        ),
        503: retryableConflictResponse,
      },
      handler: controller.updateMembershipsPermissions,
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
        403: forbiddenResponse(
          "only an organization ADMIN or the platform administrator removes members",
        ),
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
