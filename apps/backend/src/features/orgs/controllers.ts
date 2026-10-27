import type { RequestHandler } from "express";

import { ApiError, parseWith } from "../../http/errors.js";
import { logEvent } from "../../http/logging.js";
import type { AuthService } from "../auth/services.js";
import { requireSessionProfile } from "../auth/session.js";
import {
  MembershipCreateRequestSchema,
  MembershipRoleRequestSchema,
  OrganizationCreateRequestSchema,
} from "./schemas.js";
import type { OrganizationService } from "./services.js";

/** A route whose backing service is not wired answers like a missing session. */
function wired(service: OrganizationService | undefined) {
  if (!service) throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
  return service;
}

/** Success-only audit event; identifiers only (no RUT, names or secrets). */
function logAudit(
  action: string,
  ids: { organizationId: string; actorUserId: string; targetUserId: string },
) {
  logEvent("info", `audit.org_${action}`, {
    feature: "organizations",
    action,
    ...ids,
  });
}

export function createOrganizationController(
  auth: AuthService | undefined,
  organizations: OrganizationService | undefined,
) {
  const list: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const result = await wired(organizations).listOrganizations(actor.id);
    response.status(200).json({ organizations: result });
  };

  const create: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const input = parseWith(
      OrganizationCreateRequestSchema,
      request.body,
      "Invalid organization",
    );
    const created = await wired(organizations).createOrganization(
      actor.id,
      input,
    );
    response.status(201).json(created);
  };

  const listMemberships: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const memberships = await wired(organizations).listMemberships(
      actor.id,
      String(request.params.organizationId),
    );
    response.status(200).json({ memberships });
  };

  const createMembership: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const input = parseWith(
      MembershipCreateRequestSchema,
      request.body,
      "Invalid organization membership",
    );
    const organizationId = String(request.params.organizationId);
    const membership = await wired(organizations).createMembership(
      actor.id,
      organizationId,
      input,
    );
    logAudit("member_added", {
      organizationId,
      actorUserId: actor.id,
      targetUserId: membership.userId,
    });
    response.status(201).json({ membership });
  };

  const changeMembershipRole: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const input = parseWith(
      MembershipRoleRequestSchema,
      request.body,
      "Invalid organization membership",
    );
    const organizationId = String(request.params.organizationId);
    const targetUserId = String(request.params.userId);
    const { membership, changed } = await wired(
      organizations,
    ).changeMembershipRole(actor.id, organizationId, targetUserId, input.role);
    if (changed)
      logAudit("member_role_changed", {
        organizationId,
        actorUserId: actor.id,
        targetUserId,
      });
    response.status(200).json({ membership });
  };

  const removeMembership: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const organizationId = String(request.params.organizationId);
    const targetUserId = String(request.params.userId);
    await wired(organizations).removeMembership(
      actor.id,
      organizationId,
      targetUserId,
    );
    logAudit("member_removed", {
      organizationId,
      actorUserId: actor.id,
      targetUserId,
    });
    response.status(204).end();
  };

  return {
    list,
    create,
    listMemberships,
    createMembership,
    changeMembershipRole,
    removeMembership,
  };
}
