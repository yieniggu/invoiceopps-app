import type { Prisma } from "../../generated/prisma/client.js";

// Lock order is always: organization Group rows ordered by id, then single
// Group rows. Invoice writes (RP0-09/RP0-10) must take
// `SELECT id FROM "Group" WHERE id = $1 FOR SHARE` on the same row before they
// evaluate the group flags, so a configuration or membership change and an
// authorized write serialize on the group.

/** Locks one group row until the surrounding transaction ends. */
export async function lockGroup(
  transaction: Prisma.TransactionClient,
  groupId: string,
) {
  await transaction.$queryRaw`SELECT id FROM "Group" WHERE id = ${groupId} FOR UPDATE`;
}

/**
 * Locks every group of an organization in id order. Organization membership
 * removal and role changes take it before touching any group membership.
 */
export async function lockOrganizationGroups(
  transaction: Prisma.TransactionClient,
  organizationId: string,
) {
  await transaction.$queryRaw`SELECT id FROM "Group" WHERE "organizationId" = ${organizationId} ORDER BY id FOR UPDATE`;
}
