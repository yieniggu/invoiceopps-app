import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import { pageWindow, type PageQuery } from "../../pagination.js";
import {
  isUniqueViolation,
  runSerializable,
  SERIALIZABLE,
} from "../../transactions.js";
import {
  requireOrganizationAdmin,
  resolveGroupVisibility,
} from "../orgs/authority.js";
import {
  NO_INVOICE_PERMISSIONS,
  PERMISSION_SELECT,
  permissionsOf,
  type InvoicePermissions,
} from "./invoice-permissions.js";
import {
  auditGroupMembershipsCreated,
  auditGroupMembershipsRemoved,
  auditPermissionsChanged,
} from "./membership-audit.js";
import {
  lockGroupMembershipForUpdate,
  lockGroupMembershipsForUpdate,
  lockOrganizationMembershipForShare,
  lockOrganizationMembershipsForShare,
} from "./locks.js";
import type {
  GroupCreateRequest,
  GroupDto,
  GroupMembershipDto,
  GroupMembershipListResponse,
  GroupCatalogEntry,
} from "./types.js";

const GROUP_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  description: true,
} satisfies Prisma.GroupSelect;

const GROUP_MEMBERSHIP_SELECT = {
  userId: true,
  groupId: true,
  organizationId: true,
  ...PERMISSION_SELECT,
} satisfies Prisma.GroupMembershipSelect;

function toGroupMembershipDto(row: {
  userId: string;
  groupId: string;
  organizationId: string;
  readInvoices: boolean;
  createInvoices: boolean;
  deleteOwnInvoices: boolean;
  deleteOthersInvoices: boolean;
}): GroupMembershipDto {
  return {
    userId: row.userId,
    groupId: row.groupId,
    organizationId: row.organizationId,
    permissions: permissionsOf(row),
  };
}

function notFound() {
  return new ApiError(404, "NOT_FOUND", "Not found");
}

export interface GroupService {
  listGroups(actorUserId: string, organizationId: string): Promise<GroupDto[]>;
  createGroup(
    actorUserId: string,
    organizationId: string,
    input: GroupCreateRequest,
  ): Promise<GroupDto>;
  updateMemberPermissions(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    userId: string,
    permissions: InvoicePermissions,
  ): Promise<GroupMembershipDto>;
  listMemberships(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    query: PageQuery & { userIds?: string[] },
  ): Promise<GroupMembershipListResponse>;
  addMember(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    userId: string,
    permissions?: InvoicePermissions,
  ): Promise<GroupMembershipDto>;
  addMembers(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    members: Array<{ userId: string; permissions?: InvoicePermissions }>,
  ): Promise<GroupMembershipDto[]>;
  updateMembersPermissions(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    userIds: string[],
    permissions: InvoicePermissions,
  ): Promise<GroupMembershipDto[]>;
  removeMember(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    userId: string,
  ): Promise<void>;
}

export function createGroupService(prisma: PrismaClient): GroupService {
  async function requireGroup(
    database: Prisma.TransactionClient,
    organizationId: string,
    groupId: string,
  ) {
    const group = await database.group.findFirst({
      where: { id: groupId, organizationId },
      select: { id: true },
    });
    if (!group) throw notFound();
  }

  return {
    async listGroups(actorUserId, organizationId) {
      // One snapshot: the visibility decision and the rows must agree. Under
      // runSerializable so a timeout (P2028) answers the retryable 503.
      return runSerializable(
        () =>
          prisma.$transaction(
            async (transaction) => {
              const visibility = await resolveGroupVisibility(
                transaction,
                actorUserId,
                organizationId,
              );
              return transaction.group.findMany({
                where: {
                  organizationId,
                  ...(visibility === "all"
                    ? {}
                    : { memberships: { some: { userId: actorUserId } } }),
                },
                orderBy: [{ name: "asc" }, { id: "asc" }],
                select: GROUP_SELECT,
              });
            },
            { isolationLevel: "RepeatableRead" },
          ),
        undefined,
        "group_list",
      );
    },

    async createGroup(actorUserId, organizationId, input) {
      await requireOrganizationAdmin(prisma, actorUserId, organizationId);
      // The creator is not added: membership is a separate, explicit action.
      return prisma.group.create({
        data: {
          organizationId,
          name: input.name,
          description: input.description,
        },
        select: GROUP_SELECT,
      });
    },

    async updateMemberPermissions(
      actorUserId,
      organizationId,
      groupId,
      userId,
      permissions,
    ) {
      return runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await requireOrganizationAdmin(
              transaction,
              actorUserId,
              organizationId,
            );
            await requireGroup(transaction, organizationId, groupId);
            const locked = await lockGroupMembershipForUpdate(transaction, {
              userId,
              organizationId,
              groupId,
            });
            if (!locked) throw notFound();
            const updated = await transaction.groupMembership.update({
              where: { groupId_userId: { groupId, userId } },
              data: permissions,
              select: GROUP_MEMBERSHIP_SELECT,
            });
            await auditPermissionsChanged(
              transaction,
              { actorUserId, organizationId, groupId },
              [{ userId, permissions }],
            );
            return toGroupMembershipDto(updated);
          }, SERIALIZABLE),
        undefined,
        "groups.updateMemberPermissions",
      );
    },

    async listMemberships(actorUserId, organizationId, groupId, query) {
      // One snapshot for the count and the page, so total matches the rows.
      return runSerializable(
        () =>
          prisma.$transaction(
            async (transaction) => {
              await requireOrganizationAdmin(
                transaction,
                actorUserId,
                organizationId,
              );
              await requireGroup(transaction, organizationId, groupId);
              const where = {
                groupId,
                organizationId,
                ...(query.userIds ? { userId: { in: query.userIds } } : {}),
              };
              const total = await transaction.groupMembership.count({ where });
              const memberships = await transaction.groupMembership.findMany({
                where,
                orderBy: [
                  { user: { name: "asc" } },
                  { user: { rut: "asc" } },
                  { userId: "asc" },
                ],
                ...pageWindow(query),
                select: {
                  ...GROUP_MEMBERSHIP_SELECT,
                  user: { select: { id: true, name: true, rut: true } },
                },
              });
              return {
                memberships: memberships.map(({ user, ...membership }) => ({
                  ...toGroupMembershipDto(membership),
                  user,
                })),
                page: query.page,
                pageSize: query.pageSize,
                total,
              };
            },
            { isolationLevel: "RepeatableRead" },
          ),
        undefined,
        "group_memberships_list",
      );
    },

    async addMember(actorUserId, organizationId, groupId, userId, permissions) {
      return runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await requireOrganizationAdmin(
              transaction,
              actorUserId,
              organizationId,
            );
            await requireGroup(transaction, organizationId, groupId);
            // FOR SHARE on the organization membership: a concurrent removal of
            // that membership waits for this transaction (or this one for it).
            const organizationMembership =
              await lockOrganizationMembershipForShare(transaction, {
                userId,
                organizationId,
              });
            if (!organizationMembership) {
              throw new ApiError(
                409,
                "ORGANIZATION_MEMBERSHIP_REQUIRED",
                "The user must belong to the organization first",
              );
            }
            try {
              const created = await transaction.groupMembership.create({
                data: {
                  groupId,
                  userId,
                  organizationId,
                  ...(permissions ?? NO_INVOICE_PERMISSIONS),
                },
                select: GROUP_MEMBERSHIP_SELECT,
              });
              await auditGroupMembershipsCreated(
                transaction,
                { actorUserId, organizationId, groupId },
                [{ userId, permissions: permissionsOf(created) }],
              );
              return toGroupMembershipDto(created);
            } catch (error) {
              if (isUniqueViolation(error)) {
                throw new ApiError(
                  409,
                  "MEMBERSHIP_CONFLICT",
                  "The user already belongs to the group",
                );
              }
              throw error;
            }
          }, SERIALIZABLE),
        undefined,
        "groups.addMember",
      );
    },

    async addMembers(actorUserId, organizationId, groupId, members) {
      const userIds = members.map((member) => member.userId);
      return runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await requireOrganizationAdmin(
              transaction,
              actorUserId,
              organizationId,
            );
            await requireGroup(transaction, organizationId, groupId);
            // All organization memberships FOR SHARE in id order; one missing
            // user aborts the whole batch before any write.
            const locked = await lockOrganizationMembershipsForShare(
              transaction,
              { organizationId, userIds },
            );
            if (locked.length !== userIds.length) {
              throw new ApiError(
                409,
                "ORGANIZATION_MEMBERSHIP_REQUIRED",
                "Every user must belong to the organization first",
              );
            }
            try {
              await transaction.groupMembership.createMany({
                data: members.map((member) => ({
                  groupId,
                  userId: member.userId,
                  organizationId,
                  ...(member.permissions ?? NO_INVOICE_PERMISSIONS),
                })),
              });
            } catch (error) {
              if (isUniqueViolation(error)) {
                throw new ApiError(
                  409,
                  "MEMBERSHIP_CONFLICT",
                  "A user already belongs to the group",
                );
              }
              throw error;
            }
            const rows = await transaction.groupMembership.findMany({
              where: { groupId, userId: { in: userIds } },
              select: GROUP_MEMBERSHIP_SELECT,
            });
            const byUser = new Map(rows.map((row) => [row.userId, row]));
            await auditGroupMembershipsCreated(
              transaction,
              { actorUserId, organizationId, groupId },
              userIds.map((id) => ({
                userId: id,
                permissions: permissionsOf(byUser.get(id)!),
              })),
            );
            return userIds.map((id) => toGroupMembershipDto(byUser.get(id)!));
          }, SERIALIZABLE),
        undefined,
        "groups.addMembers",
      );
    },

    async updateMembersPermissions(
      actorUserId,
      organizationId,
      groupId,
      userIds,
      permissions,
    ) {
      return runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await requireOrganizationAdmin(
              transaction,
              actorUserId,
              organizationId,
            );
            await requireGroup(transaction, organizationId, groupId);
            // Organization memberships FOR SHARE, then the group memberships
            // FOR UPDATE, each in id order (same order as the single PUT).
            const locked = await lockGroupMembershipsForUpdate(transaction, {
              organizationId,
              groupId,
              userIds,
            });
            if (locked.length !== userIds.length) throw notFound();
            await transaction.groupMembership.updateMany({
              where: { groupId, userId: { in: userIds } },
              data: permissions,
            });
            await auditPermissionsChanged(
              transaction,
              { actorUserId, organizationId, groupId },
              userIds.map((id) => ({ userId: id, permissions })),
            );
            const rows = await transaction.groupMembership.findMany({
              where: { groupId, userId: { in: userIds } },
              select: GROUP_MEMBERSHIP_SELECT,
            });
            const byUser = new Map(rows.map((row) => [row.userId, row]));
            return userIds.map((id) => toGroupMembershipDto(byUser.get(id)!));
          }, SERIALIZABLE),
        undefined,
        "groups.updateMembersPermissions",
      );
    },

    async removeMember(actorUserId, organizationId, groupId, userId) {
      await runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await requireOrganizationAdmin(
              transaction,
              actorUserId,
              organizationId,
            );
            await requireGroup(transaction, organizationId, groupId);
            const locked = await lockGroupMembershipForUpdate(transaction, {
              userId,
              organizationId,
              groupId,
            });
            if (!locked) throw notFound();
            const result = await transaction.groupMembership.deleteMany({
              where: { groupId, userId },
            });
            if (result.count !== 1) throw notFound();
            await auditGroupMembershipsRemoved(
              transaction,
              { actorUserId, organizationId },
              [{ userId, groupId }],
            );
          }, SERIALIZABLE),
        undefined,
        "groups.removeMember",
      );
    },
  };
}

/** Read-only listing behind the undocumented GET /api/v1/groups. */
export interface GroupCatalogService {
  listGroups(userId: string): Promise<GroupCatalogEntry[]>;
}

export function createGroupCatalogService(
  prisma: PrismaClient,
): GroupCatalogService {
  return {
    async listGroups(userId) {
      const groups = await prisma.group.findMany({
        where: { memberships: { some: { userId } } },
        orderBy: [
          { organization: { name: "asc" } },
          { name: "asc" },
          { id: "asc" },
        ],
        include: { organization: { select: { id: true, name: true } } },
      });

      return groups.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        organization: group.organization,
      }));
    },
  };
}
