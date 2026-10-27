import {
  OrganizationRole,
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import { formatRut } from "../../rut.js";
import { isUniqueViolation, runSerializable } from "../../transactions.js";
import {
  requireOrganizationAdmin,
  requireOrganizationMember,
} from "../orgs/authority.js";
import { lockGroup } from "./locks.js";
import type {
  GroupCreateRequest,
  GroupDto,
  GroupMembershipDto,
  GroupMembershipWithUserDto,
  GroupPermissions,
  GroupWithMembersResponse,
} from "./types.js";

const SERIALIZABLE = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;

const GROUP_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  description: true,
  readInvoices: true,
  createInvoices: true,
  deleteOwnInvoices: true,
  deleteOthersInvoices: true,
} satisfies Prisma.GroupSelect;

function toGroupDto(group: {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  readInvoices: boolean;
  createInvoices: boolean;
  deleteOwnInvoices: boolean;
  deleteOthersInvoices: boolean;
}): GroupDto {
  return {
    id: group.id,
    organizationId: group.organizationId,
    name: group.name,
    description: group.description,
    permissions: {
      readInvoices: group.readInvoices,
      createInvoices: group.createInvoices,
      deleteOwnInvoices: group.deleteOwnInvoices,
      deleteOthersInvoices: group.deleteOthersInvoices,
    },
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
  updatePermissions(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    permissions: GroupPermissions,
  ): Promise<GroupDto>;
  listMemberships(
    actorUserId: string,
    organizationId: string,
    groupId: string,
  ): Promise<GroupMembershipWithUserDto[]>;
  addMember(
    actorUserId: string,
    organizationId: string,
    groupId: string,
    userId: string,
  ): Promise<GroupMembershipDto>;
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
      const { role } = await requireOrganizationMember(
        prisma,
        actorUserId,
        organizationId,
      );
      const groups = await prisma.group.findMany({
        where: {
          organizationId,
          ...(role === OrganizationRole.ADMIN
            ? {}
            : { memberships: { some: { userId: actorUserId } } }),
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: GROUP_SELECT,
      });
      return groups.map(toGroupDto);
    },

    async createGroup(actorUserId, organizationId, input) {
      await requireOrganizationAdmin(prisma, actorUserId, organizationId);
      // The creator is not added: membership is a separate, explicit action.
      const group = await prisma.group.create({
        data: {
          organizationId,
          name: input.name,
          description: input.description,
        },
        select: GROUP_SELECT,
      });
      return toGroupDto(group);
    },

    async updatePermissions(actorUserId, organizationId, groupId, permissions) {
      return runSerializable(() =>
        prisma.$transaction(async (transaction) => {
          await requireOrganizationAdmin(
            transaction,
            actorUserId,
            organizationId,
          );
          await lockGroup(transaction, groupId);
          await requireGroup(transaction, organizationId, groupId);
          const group = await transaction.group.update({
            where: { id: groupId },
            data: permissions,
            select: GROUP_SELECT,
          });
          return toGroupDto(group);
        }, SERIALIZABLE),
      );
    },

    async listMemberships(actorUserId, organizationId, groupId) {
      await requireOrganizationAdmin(prisma, actorUserId, organizationId);
      await requireGroup(prisma, organizationId, groupId);
      return prisma.groupMembership.findMany({
        where: { groupId, organizationId },
        orderBy: [
          { user: { name: "asc" } },
          { user: { rut: "asc" } },
          { userId: "asc" },
        ],
        select: {
          userId: true,
          groupId: true,
          organizationId: true,
          user: { select: { id: true, name: true, rut: true } },
        },
      });
    },

    async addMember(actorUserId, organizationId, groupId, userId) {
      return runSerializable(() =>
        prisma.$transaction(async (transaction) => {
          await requireOrganizationAdmin(
            transaction,
            actorUserId,
            organizationId,
          );
          await lockGroup(transaction, groupId);
          await requireGroup(transaction, organizationId, groupId);
          const organizationMembership =
            await transaction.organizationMembership.findUnique({
              where: { userId_organizationId: { userId, organizationId } },
              select: { userId: true },
            });
          if (!organizationMembership) {
            throw new ApiError(
              409,
              "ORGANIZATION_MEMBERSHIP_REQUIRED",
              "The user must belong to the organization first",
            );
          }
          try {
            return await transaction.groupMembership.create({
              data: { groupId, userId, organizationId },
              select: { userId: true, groupId: true, organizationId: true },
            });
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
      );
    },

    async removeMember(actorUserId, organizationId, groupId, userId) {
      await runSerializable(() =>
        prisma.$transaction(async (transaction) => {
          await requireOrganizationAdmin(
            transaction,
            actorUserId,
            organizationId,
          );
          await lockGroup(transaction, groupId);
          await requireGroup(transaction, organizationId, groupId);
          const result = await transaction.groupMembership.deleteMany({
            where: { groupId, userId },
          });
          if (result.count !== 1) throw notFound();
        }, SERIALIZABLE),
      );
    },
  };
}

/** Read-only listing behind the undocumented GET /api/v1/groups. */
export interface GroupCatalogService {
  listGroups(userId: string): Promise<GroupWithMembersResponse[]>;
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
        include: {
          organization: { select: { id: true, name: true } },
          memberships: {
            orderBy: [
              { user: { name: "asc" } },
              { user: { rut: "asc" } },
              { userId: "asc" },
            ],
            select: { user: { select: { id: true, name: true, rut: true } } },
          },
        },
      });

      return groups.map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        organization: group.organization,
        members: group.memberships.map(({ user }) => ({
          ...user,
          rut: formatRut(user.rut),
        })),
      }));
    },
  };
}
