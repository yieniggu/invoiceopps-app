import {
  OrganizationRole,
  type Prisma,
} from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import { loadEffectivePermissions } from "../groups/invoice-permissions.js";

export async function isPlatformAdministrator(
  database: Prisma.TransactionClient,
  userId: string,
) {
  const administrator = await database.platformAdministrator.findUnique({
    where: { id: 1 },
    select: { userId: true },
  });
  return administrator?.userId === userId;
}

/**
 * Administrative authority over an organization: an organization ADMIN, or the
 * platform administrator over any existing organization (404 when it does not
 * exist). This is administrative authority only: it never grants invoice
 * permissions. An actor with no membership gets 404 so the existence of the
 * organization is not revealed; a plain member on an ADMIN-only operation gets
 * 403.
 */
export async function requireOrganizationAdmin(
  database: Prisma.TransactionClient,
  actorUserId: string,
  organizationId: string,
) {
  const membership = await database.organizationMembership.findUnique({
    where: {
      userId_organizationId: { userId: actorUserId, organizationId },
    },
    select: { role: true },
  });
  if (membership?.role === OrganizationRole.ADMIN) return;

  if (await isPlatformAdministrator(database, actorUserId)) {
    const organization = await database.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) throw new ApiError(404, "NOT_FOUND", "Not found");
    return;
  }

  if (!membership) throw new ApiError(404, "NOT_FOUND", "Not found");
  throw new ApiError(403, "FORBIDDEN", "Forbidden");
}

/**
 * Which groups of an organization the actor sees: every group for an
 * organization ADMIN and for the platform administrator, only own groups for a
 * plain member. Actors with neither get 404.
 */
export async function organizationGroupVisibility(
  database: Prisma.TransactionClient,
  actorUserId: string,
  organizationId: string,
): Promise<"all" | "own"> {
  const membership = await database.organizationMembership.findUnique({
    where: {
      userId_organizationId: { userId: actorUserId, organizationId },
    },
    select: { role: true },
  });
  if (membership?.role === OrganizationRole.ADMIN) return "all";
  if (await isPlatformAdministrator(database, actorUserId)) {
    const organization = await database.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) throw new ApiError(404, "NOT_FOUND", "Not found");
    return "all";
  }
  if (!membership) throw new ApiError(404, "NOT_FOUND", "Not found");
  return "own";
}

/**
 * The groups the actor may see: organizationGroupVisibility, widened to every
 * group for an organization-wide invoice reader (it may open any group's
 * invoices, so it must be able to name and pick them). Disabled organizations
 * and pending onboarding grant nothing (loadEffectivePermissions). Single
 * source for the group list and the group count of the organization summary,
 * so the two always agree. Actors with no access get 404.
 */
export async function resolveGroupVisibility(
  database: Prisma.TransactionClient,
  actorUserId: string,
  organizationId: string,
): Promise<"all" | "own"> {
  const visibility = await organizationGroupVisibility(
    database,
    actorUserId,
    organizationId,
  );
  if (visibility === "all") return "all";
  const organizationRead = await loadEffectivePermissions(database, {
    userId: actorUserId,
    organizationId,
    groupId: null,
  });
  return organizationRead.readInvoices ? "all" : "own";
}

/** 403 unless the actor is the platform administrator. */
export async function requirePlatformAdministrator(
  database: Prisma.TransactionClient,
  actorUserId: string,
) {
  if (!(await isPlatformAdministrator(database, actorUserId))) {
    throw new ApiError(403, "FORBIDDEN", "Forbidden");
  }
}
