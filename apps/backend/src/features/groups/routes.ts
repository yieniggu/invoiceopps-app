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
import { createGroupController } from "./controllers.js";
import {
  GroupCreateRequestSchema,
  GroupListResponseSchema,
  GroupMembershipBulkCreateRequestSchema,
  GroupMembershipCreateRequestSchema,
  GroupMembershipsResponseSchema,
  GroupMembershipListQuerySchema,
  GroupMembershipListResponseSchema,
  GroupMembershipParamsSchema,
  GroupMembershipResponseSchema,
  GroupParamsSchema,
  GroupResponseSchema,
} from "./schemas.js";
import {
  BulkPermissionsUpdateRequestSchema,
  PermissionsUpdateRequestSchema,
} from "./permissions-schema.js";
import type { GroupService } from "./services.js";

const TAG = "Groups";
const NOT_A_MEMBER =
  "the organization does not exist or the actor is neither a member nor the platform administrator (the platform administrator administers every existing organization but has no implicit membership)";
const NO_GROUP = `${NOT_A_MEMBER}, or the group belongs to another organization`;
const ADMIN_ONLY =
  "only an organization ADMIN or the platform administrator administers groups";

export function createGroupOperations(
  auth: AuthService | undefined,
  groups: GroupService | undefined,
): Operation[] {
  const controller = createGroupController(auth, groups);

  return [
    {
      method: "get",
      path: "/organizations/{organizationId}/groups",
      summary:
        "List groups (an ADMIN and the platform administrator see all, a USER only own groups)",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      responses: {
        200: {
          description: "Groups of the organization",
          schema: GroupListResponseSchema,
        },
        401: unauthenticatedResponse,
        403: forbiddenResponse("a temporary password is still pending"),
        404: notFoundResponse(NOT_A_MEMBER),
      },
      handler: controller.list,
    },
    {
      method: "post",
      path: "/organizations/{organizationId}/groups",
      summary: "Create a group",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      requestBody: GroupCreateRequestSchema,
      responses: {
        201: {
          description: "Group created; the creator is not added as a member",
          schema: GroupResponseSchema,
        },
        400: validationResponse("invalid or unknown body field"),
        401: unauthenticatedResponse,
        403: forbiddenResponse(ADMIN_ONLY),
        404: notFoundResponse(NOT_A_MEMBER),
      },
      handler: controller.create,
    },
    {
      method: "get",
      path: "/organizations/{organizationId}/groups/{groupId}/memberships",
      summary: "List the members of a group",
      tag: TAG,
      secured: true,
      params: GroupParamsSchema,
      query: GroupMembershipListQuerySchema,
      responses: {
        200: {
          description:
            "One page of group memberships with a user summary, ordered by name, RUT and id; total counts every membership, or only those of the requested userIds",
          schema: GroupMembershipListResponseSchema,
        },
        400: validationResponse(
          "unknown or repeated query parameter, page outside 1..10000, pageSize outside 1..100, or userIds empty, over 200, with duplicates or non-UUID values",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(ADMIN_ONLY),
        404: notFoundResponse(NO_GROUP),
      },
      handler: controller.listMemberships,
    },
    {
      method: "post",
      path: "/organizations/{organizationId}/groups/{groupId}/memberships",
      summary:
        "Add an organization member to a group, with optional invoice permissions",
      tag: TAG,
      secured: true,
      params: GroupParamsSchema,
      requestBody: GroupMembershipCreateRequestSchema,
      responses: {
        201: {
          description: "Membership created (permissions default to all false)",
          schema: GroupMembershipResponseSchema,
        },
        400: validationResponse(
          "userId is missing or not a UUID, permissions are malformed or a field is unknown",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(ADMIN_ONLY),
        404: notFoundResponse(NO_GROUP),
        409: errorResponse(
          "ORGANIZATION_MEMBERSHIP_REQUIRED: the user is not a member of the organization; MEMBERSHIP_CONFLICT: the user already belongs to the group",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.addMember,
    },
    {
      method: "post",
      path: "/organizations/{organizationId}/groups/{groupId}/memberships/bulk",
      summary:
        "Add several organization members to a group at once, each with its own invoice permissions",
      tag: TAG,
      secured: true,
      params: GroupParamsSchema,
      requestBody: GroupMembershipBulkCreateRequestSchema,
      largeBody: true,
      responses: {
        201: {
          description:
            "Every membership created atomically (all or nothing), in request order",
          schema: GroupMembershipsResponseSchema,
        },
        400: validationResponse(
          "members is empty, over 200, has duplicate or non-UUID userId values, or a field is unknown; nothing is persisted",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(ADMIN_ONLY),
        404: notFoundResponse(NO_GROUP),
        409: errorResponse(
          "ORGANIZATION_MEMBERSHIP_REQUIRED: a user is not a member of the organization; MEMBERSHIP_CONFLICT: a user already belongs to the group; nothing is persisted",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.addMembers,
    },
    {
      method: "put",
      path: "/organizations/{organizationId}/groups/{groupId}/memberships/permissions",
      summary:
        "Replace the four invoice permissions of several group memberships at once",
      tag: TAG,
      secured: true,
      params: GroupParamsSchema,
      requestBody: BulkPermissionsUpdateRequestSchema,
      largeBody: true,
      responses: {
        200: {
          description:
            "Permissions of every listed member replaced atomically (all or nothing), in request order",
          schema: GroupMembershipsResponseSchema,
        },
        400: validationResponse(
          "userIds is empty, over 200, has duplicates or non-UUID values, a flag is missing, or a field is unknown; nothing is persisted",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(ADMIN_ONLY),
        404: notFoundResponse(
          `${NO_GROUP}, or any listed user is not in the group (nothing is persisted)`,
        ),
        503: retryableConflictResponse,
      },
      handler: controller.updateMembersPermissions,
    },
    {
      method: "put",
      path: "/organizations/{organizationId}/groups/{groupId}/memberships/{userId}/permissions",
      summary: "Replace the four invoice permissions of a group membership",
      tag: TAG,
      secured: true,
      params: GroupMembershipParamsSchema,
      requestBody: PermissionsUpdateRequestSchema,
      responses: {
        200: {
          description:
            "Permissions replaced atomically; they apply from the next request of that user",
          schema: GroupMembershipResponseSchema,
        },
        400: validationResponse(
          "a flag is missing or not a boolean, or a field is unknown; nothing is persisted",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(ADMIN_ONLY),
        404: notFoundResponse(`${NO_GROUP}, or the user is not in the group`),
        503: retryableConflictResponse,
      },
      handler: controller.updateMemberPermissions,
    },
    {
      method: "delete",
      path: "/organizations/{organizationId}/groups/{groupId}/memberships/{userId}",
      summary: "Remove a member from a group",
      tag: TAG,
      secured: true,
      params: GroupMembershipParamsSchema,
      responses: {
        204: { description: "Membership removed" },
        401: unauthenticatedResponse,
        403: forbiddenResponse(ADMIN_ONLY),
        404: notFoundResponse(`${NO_GROUP}, or the user is not in the group`),
        503: retryableConflictResponse,
      },
      handler: controller.removeMember,
    },
  ];
}
