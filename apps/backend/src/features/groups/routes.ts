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
  GroupMembershipCreateRequestSchema,
  GroupMembershipListResponseSchema,
  GroupMembershipParamsSchema,
  GroupMembershipResponseSchema,
  GroupParamsSchema,
  GroupPermissionsUpdateRequestSchema,
  GroupResponseSchema,
} from "./schemas.js";
import type { GroupService } from "./services.js";

const TAG = "Groups";
const NOT_A_MEMBER =
  "the organization does not exist or the actor is not a member (the platform administrator has no implicit membership)";
const NO_GROUP = `${NOT_A_MEMBER}, or the group belongs to another organization`;
const ADMIN_ONLY = "only an organization ADMIN administers groups";

export function createGroupOperations(
  auth: AuthService | undefined,
  groups: GroupService | undefined,
): Operation[] {
  const controller = createGroupController(auth, groups);

  return [
    {
      method: "get",
      path: "/organizations/{organizationId}/groups",
      summary: "List groups (an ADMIN sees all, a USER only own groups)",
      tag: TAG,
      secured: true,
      params: OrganizationParamsSchema,
      responses: {
        200: {
          description: "Groups with their four flags",
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
      summary: "Create a group with every permission flag false",
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
      method: "patch",
      path: "/organizations/{organizationId}/groups/{groupId}",
      summary: "Replace the four permission flags of a group",
      tag: TAG,
      secured: true,
      params: GroupParamsSchema,
      requestBody: GroupPermissionsUpdateRequestSchema,
      responses: {
        200: {
          description:
            "Flags replaced atomically; every member sees them from the next request",
          schema: GroupResponseSchema,
        },
        400: validationResponse(
          "a flag is missing or not a boolean, or a field is unknown",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(ADMIN_ONLY),
        404: notFoundResponse(NO_GROUP),
        409: errorResponse(
          "CONFLICT: the update kept conflicting with concurrent changes; retry",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.updatePermissions,
    },
    {
      method: "get",
      path: "/organizations/{organizationId}/groups/{groupId}/memberships",
      summary: "List the members of a group",
      tag: TAG,
      secured: true,
      params: GroupParamsSchema,
      responses: {
        200: {
          description: "Group memberships with a user summary",
          schema: GroupMembershipListResponseSchema,
        },
        401: unauthenticatedResponse,
        403: forbiddenResponse(ADMIN_ONLY),
        404: notFoundResponse(NO_GROUP),
      },
      handler: controller.listMemberships,
    },
    {
      method: "post",
      path: "/organizations/{organizationId}/groups/{groupId}/memberships",
      summary: "Add an organization member to a group",
      tag: TAG,
      secured: true,
      params: GroupParamsSchema,
      requestBody: GroupMembershipCreateRequestSchema,
      responses: {
        201: {
          description:
            "Membership created; it carries no permissions of its own",
          schema: GroupMembershipResponseSchema,
        },
        400: validationResponse("userId is missing or a field is unknown"),
        401: unauthenticatedResponse,
        403: forbiddenResponse(ADMIN_ONLY),
        404: notFoundResponse(NO_GROUP),
        409: errorResponse(
          "ORGANIZATION_MEMBERSHIP_REQUIRED: the user is not a member of the organization; MEMBERSHIP_CONFLICT: the user already belongs to the group; CONFLICT: concurrent changes kept conflicting; retry",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.addMember,
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
