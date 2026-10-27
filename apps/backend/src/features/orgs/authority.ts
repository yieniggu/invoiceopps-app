import {
  OrganizationRole,
  type Prisma,
} from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";

/**
 * Organization-scoped authority. An actor with no membership in the
 * organization (the platform administrator included) gets 404 so the existence
 * of the organization is not revealed; a plain member on an ADMIN-only
 * operation gets 403.
 */
export async function requireOrganizationAdmin(
  database: Prisma.TransactionClient,
  actorUserId: string,
  organizationId: string,
) {
  const membership = await requireOrganizationMember(
    database,
    actorUserId,
    organizationId,
  );
  if (membership.role !== OrganizationRole.ADMIN) {
    throw new ApiError(403, "FORBIDDEN", "Forbidden");
  }
}

export async function requireOrganizationMember(
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
  if (!membership) throw new ApiError(404, "NOT_FOUND", "Not found");
  return membership;
}
