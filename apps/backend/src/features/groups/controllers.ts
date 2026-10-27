import type { RequestHandler } from "express";

import { ApiError, parseWith } from "../../http/errors.js";
import { logEvent } from "../../http/logging.js";
import type { AuthService } from "../auth/services.js";
import { requireSessionProfile } from "../auth/session.js";
import {
  GroupCreateRequestSchema,
  GroupMembershipCreateRequestSchema,
  GroupPermissionsUpdateRequestSchema,
} from "./schemas.js";
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

  const updatePermissions: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const input = parseWith(
      GroupPermissionsUpdateRequestSchema,
      request.body,
      "Invalid group permissions",
    );
    const organizationId = String(request.params.organizationId);
    const groupId = String(request.params.groupId);
    const group = await wired(groups).updatePermissions(
      actor.id,
      organizationId,
      groupId,
      input.permissions,
    );
    logAudit("permissions_updated", {
      organizationId,
      groupId,
      actorUserId: actor.id,
    });
    response.status(200).json({ group });
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
    );
    logAudit("member_added", {
      organizationId,
      groupId,
      actorUserId: actor.id,
      targetUserId: input.userId,
    });
    response.status(201).json({ membership });
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
    updatePermissions,
    listMemberships,
    addMember,
    removeMember,
  };
}
