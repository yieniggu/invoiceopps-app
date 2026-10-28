import type { RequestHandler } from "express";

import { ApiError, parseWith } from "../../http/errors.js";
import { logEvent } from "../../http/logging.js";
import type { AuthService } from "../auth/services.js";
import { requireSessionProfile } from "../auth/session.js";
import {
  GroupCreateRequestSchema,
  GroupMembershipBulkCreateRequestSchema,
  GroupMembershipCreateRequestSchema,
} from "./schemas.js";
import {
  BulkPermissionsUpdateRequestSchema,
  PermissionsUpdateRequestSchema,
} from "./permissions-schema.js";
import type { GroupService } from "./services.js";

function wired(service: GroupService | undefined) {
  if (!service) throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
  return service;
}

/** Success-only audit event; identifiers only (no RUT, names or secrets). */
function logAudit(
  action: string,
  ids: {
    organizationId: string;
    groupId: string;
    actorUserId: string;
    targetUserId?: string;
    memberCount?: number;
  },
) {
  logEvent("info", `audit.group_${action}`, {
    feature: "groups",
    action,
    ...ids,
  });
}

export function createGroupController(
  auth: AuthService | undefined,
  groups: GroupService | undefined,
) {
  const list: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const result = await wired(groups).listGroups(
      actor.id,
      String(request.params.organizationId),
    );
    response.status(200).json({ groups: result });
  };

  const create: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const input = parseWith(
      GroupCreateRequestSchema,
      request.body,
      "Invalid group",
    );
    const group = await wired(groups).createGroup(
      actor.id,
      String(request.params.organizationId),
      input,
    );
    response.status(201).json({ group });
  };

  const updateMemberPermissions: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const input = parseWith(
      PermissionsUpdateRequestSchema,
      request.body,
      "Invalid permissions",
    );
    const organizationId = String(request.params.organizationId);
    const groupId = String(request.params.groupId);
    const targetUserId = String(request.params.userId);
    const membership = await wired(groups).updateMemberPermissions(
      actor.id,
      organizationId,
      groupId,
      targetUserId,
      input.permissions,
    );
    logAudit("member_permissions_updated", {
      organizationId,
      groupId,
      actorUserId: actor.id,
      targetUserId,
    });
    response.status(200).json({ membership });
  };

  const listMemberships: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const memberships = await wired(groups).listMemberships(
      actor.id,
      String(request.params.organizationId),
      String(request.params.groupId),
    );
    response.status(200).json({ memberships });
  };

  const addMember: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const input = parseWith(
      GroupMembershipCreateRequestSchema,
      request.body,
      "Invalid group membership",
    );
    const organizationId = String(request.params.organizationId);
    const groupId = String(request.params.groupId);
    const membership = await wired(groups).addMember(
      actor.id,
      organizationId,
      groupId,
      input.userId,
      input.permissions,
    );
    logAudit("member_added", {
      organizationId,
      groupId,
      actorUserId: actor.id,
      targetUserId: input.userId,
    });
    response.status(201).json({ membership });
  };

  const addMembers: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const input = parseWith(
      GroupMembershipBulkCreateRequestSchema,
      request.body,
      "Invalid group memberships",
    );
    const organizationId = String(request.params.organizationId);
    const groupId = String(request.params.groupId);
    const memberships = await wired(groups).addMembers(
      actor.id,
      organizationId,
      groupId,
      input.members,
    );
    // One audit line for the whole batch: identifiers and a count only.
    logAudit("members_added", {
      organizationId,
      groupId,
      actorUserId: actor.id,
      memberCount: memberships.length,
    });
    response.status(201).json({ memberships });
  };

  const updateMembersPermissions: RequestHandler = async (
    request,
    response,
  ) => {
    const actor = await requireSessionProfile(auth, request, response);
    const input = parseWith(
      BulkPermissionsUpdateRequestSchema,
      request.body,
      "Invalid permissions",
    );
    const organizationId = String(request.params.organizationId);
    const groupId = String(request.params.groupId);
    const memberships = await wired(groups).updateMembersPermissions(
      actor.id,
      organizationId,
      groupId,
      input.userIds,
      input.permissions,
    );
    logAudit("members_permissions_updated", {
      organizationId,
      groupId,
      actorUserId: actor.id,
      memberCount: memberships.length,
    });
    response.status(200).json({ memberships });
  };

  const removeMember: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const organizationId = String(request.params.organizationId);
    const groupId = String(request.params.groupId);
    const targetUserId = String(request.params.userId);
    await wired(groups).removeMember(
      actor.id,
      organizationId,
      groupId,
      targetUserId,
    );
    logAudit("member_removed", {
      organizationId,
      groupId,
      actorUserId: actor.id,
      targetUserId,
    });
    response.status(204).end();
  };

  return {
    list,
    create,
    updateMemberPermissions,
    listMemberships,
    addMember,
    addMembers,
    updateMembersPermissions,
    removeMember,
  };
}
