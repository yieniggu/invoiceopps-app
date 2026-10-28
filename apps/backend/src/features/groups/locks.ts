import type { Prisma } from "../../generated/prisma/client.js";

// Global lock order: OrganizationMembership -> GroupMemberships by id
// ascending. Every transaction takes the rows it needs in that order only.
// No transaction locks a User row: user provisioning creates the user inside
// its own SERIALIZABLE transaction, so nothing else can hold or wait for it.
//
// - An invoice write (create, replay, delete, token use) takes FOR SHARE on the
//   organization membership and, in group scope, on the group membership of
//   the actor, then evaluates the permission flags.
// - A permission or membership change takes FOR UPDATE on the row that changes
//   (after FOR SHARE on its organization membership when it is a group row),
//   so a change and an authorized write serialize on the membership.
// - A bulk permission change or bulk add takes the rows of all its targets in
//   the same global order: organization memberships ordered by id, then group
//   memberships ordered by id. A single-row change is the one-element case of
//   the same order, so bulk and single operations never deadlock.
// - Removing or re-roling an organization member locks that organization
//   membership FOR UPDATE and then every group membership of that user in the
//   organization in id order.

type Database = Prisma.TransactionClient;

interface MembershipRow {
  id: string;
}

interface OrganizationMembershipKey {
  userId: string;
  organizationId: string;
}

interface GroupMembershipKey extends OrganizationMembershipKey {
  groupId: string;
}

/**
 * FOR SHARE on the organization membership and, when `groupId` is set, on the
 * group membership. Rows that do not exist come back as null.
 */
export async function lockMembershipsForInvoiceWrite(
  transaction: Database,
  input: OrganizationMembershipKey & { groupId: string | null },
): Promise<{
  organizationMembership: MembershipRow | null;
  groupMembership: MembershipRow | null;
}> {
  const [organizationMembership = null] = await transaction.$queryRaw<
    MembershipRow[]
  >`SELECT id FROM "OrganizationMembership" WHERE "userId" = ${input.userId} AND "organizationId" = ${input.organizationId} FOR SHARE`;
  if (input.groupId === null) {
    return { organizationMembership, groupMembership: null };
  }
  const [groupMembership = null] = await transaction.$queryRaw<
    MembershipRow[]
  >`SELECT id FROM "GroupMembership" WHERE "userId" = ${input.userId} AND "organizationId" = ${input.organizationId} AND "groupId" = ${input.groupId} FOR SHARE`;
  return { organizationMembership, groupMembership };
}

/**
 * FOR SHARE on one organization membership: a group membership is created
 * only while the organization membership it hangs from cannot be removed.
 */
export async function lockOrganizationMembershipForShare(
  transaction: Database,
  input: OrganizationMembershipKey,
): Promise<MembershipRow | null> {
  const [row = null] = await transaction.$queryRaw<
    MembershipRow[]
  >`SELECT id FROM "OrganizationMembership" WHERE "userId" = ${input.userId} AND "organizationId" = ${input.organizationId} FOR SHARE`;
  return row;
}

/** FOR UPDATE on one organization membership (permission change). */
export async function lockOrganizationMembershipForUpdate(
  transaction: Database,
  input: OrganizationMembershipKey,
): Promise<MembershipRow | null> {
  const [row = null] = await transaction.$queryRaw<
    MembershipRow[]
  >`SELECT id FROM "OrganizationMembership" WHERE "userId" = ${input.userId} AND "organizationId" = ${input.organizationId} FOR UPDATE`;
  return row;
}

/**
 * Organization membership FOR SHARE first (so a concurrent organization
 * removal serializes), then the group membership FOR UPDATE. Returns the group
 * membership row, or null when the user is not in the group.
 */
export async function lockGroupMembershipForUpdate(
  transaction: Database,
  input: GroupMembershipKey,
): Promise<MembershipRow | null> {
  await transaction.$queryRaw`SELECT id FROM "OrganizationMembership" WHERE "userId" = ${input.userId} AND "organizationId" = ${input.organizationId} FOR SHARE`;
  const [row = null] = await transaction.$queryRaw<
    MembershipRow[]
  >`SELECT id FROM "GroupMembership" WHERE "userId" = ${input.userId} AND "organizationId" = ${input.organizationId} AND "groupId" = ${input.groupId} FOR UPDATE`;
  return row;
}

/**
 * Organization membership FOR UPDATE, then every group membership of that user
 * in the organization ordered by id, FOR UPDATE. Used by organization member
 * removal and role changes.
 */
export async function lockMembershipCascadeForUpdate(
  transaction: Database,
  input: OrganizationMembershipKey,
): Promise<{ organizationMembership: MembershipRow | null }> {
  const organizationMembership = await lockOrganizationMembershipForUpdate(
    transaction,
    input,
  );
  await transaction.$queryRaw`SELECT id FROM "GroupMembership" WHERE "userId" = ${input.userId} AND "organizationId" = ${input.organizationId} ORDER BY id FOR UPDATE`;
  return { organizationMembership };
}

/**
 * FOR UPDATE on the organization memberships of several users in one
 * organization, ordered by id (bulk organization permission change). Returns
 * the user ids that have a membership.
 */
export async function lockOrganizationMembershipsForUpdate(
  transaction: Database,
  input: { organizationId: string; userIds: string[] },
): Promise<string[]> {
  const rows = await transaction.$queryRaw<
    Array<{ userId: string }>
  >`SELECT "userId" FROM "OrganizationMembership" WHERE "organizationId" = ${input.organizationId} AND "userId" = ANY(${input.userIds}::text[]) ORDER BY id FOR UPDATE`;
  return rows.map((row) => row.userId);
}

/**
 * FOR SHARE on the organization memberships of several users, ordered by id
 * (bulk group operations: the organization memberships they hang from cannot
 * be removed meanwhile). Returns the user ids that have a membership.
 */
export async function lockOrganizationMembershipsForShare(
  transaction: Database,
  input: { organizationId: string; userIds: string[] },
): Promise<string[]> {
  const rows = await transaction.$queryRaw<
    Array<{ userId: string }>
  >`SELECT "userId" FROM "OrganizationMembership" WHERE "organizationId" = ${input.organizationId} AND "userId" = ANY(${input.userIds}::text[]) ORDER BY id FOR SHARE`;
  return rows.map((row) => row.userId);
}

/**
 * Organization memberships FOR SHARE (ordered by id), then the group
 * memberships of the given users FOR UPDATE (ordered by id). Returns the user
 * ids that belong to the group.
 */
export async function lockGroupMembershipsForUpdate(
  transaction: Database,
  input: { organizationId: string; groupId: string; userIds: string[] },
): Promise<string[]> {
  await lockOrganizationMembershipsForShare(transaction, input);
  const rows = await transaction.$queryRaw<
    Array<{ userId: string }>
  >`SELECT "userId" FROM "GroupMembership" WHERE "organizationId" = ${input.organizationId} AND "groupId" = ${input.groupId} AND "userId" = ANY(${input.userIds}::text[]) ORDER BY id FOR UPDATE`;
  return rows.map((row) => row.userId);
}
