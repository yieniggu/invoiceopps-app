import {
  OrganizationRole,
  type Prisma,
  type PrismaClient,
} from "./generated/prisma/client.js";
import { AuthError } from "./auth.js";

export interface GroupService {
  listGroups(userId: string): Promise<GroupResponse[]>;
  createGroup(
    userId: string,
    organizationId: string,
    input: GroupInput,
  ): Promise<GroupResponse>;
  updateGroup(
    userId: string,
    organizationId: string,
    groupId: string,
    input: GroupUpdate,
  ): Promise<GroupResponse>;
  deleteGroup(
    userId: string,
    organizationId: string,
    groupId: string,
  ): Promise<void>;
  addMember(
    userId: string,
    organizationId: string,
    groupId: string,
    memberId: string,
  ): Promise<GroupResponse>;
  removeMember(
    userId: string,
    organizationId: string,
    groupId: string,
    memberId: string,
  ): Promise<void>;
}

export interface GroupInput {
  name: string;
  description?: string | null;
}

export interface GroupUpdate {
  name?: string;
  description?: string | null;
}

export interface GroupResponse {
  id: string;
  name: string;
  description: string | null;
  organization: { id: string; name: string };
  members: Array<{ id: string; name: string; rut: string }>;
}

const groupInclude = {
  organization: { select: { id: true, name: true } },
  memberships: {
    orderBy: [
      { user: { name: "asc" } },
      { user: { rut: "asc" } },
      { userId: "asc" },
    ],
    select: { user: { select: { id: true, name: true, rut: true } } },
  },
} satisfies Prisma.GroupInclude;

function toGroupResponse(group: {
  id: string;
  name: string;
  description: string | null;
  organization: { id: string; name: string };
  memberships: Array<{ user: { id: string; name: string; rut: string } }>;
}): GroupResponse {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    organization: group.organization,
    members: group.memberships.map(({ user }) => user),
  };
}

function groupNotFound() {
  return new AuthError(404, "Group not found");
}

export function createGroupService(prisma: PrismaClient): GroupService {
  async function requireAdmin(userId: string, organizationId: string) {
    const [membership, platformAdministrator] = await Promise.all([
      prisma.organizationMembership.findUnique({
        where: { userId_organizationId: { userId, organizationId } },
        select: { role: true },
      }),
      prisma.platformAdministrator.findUnique({
        where: { id: 1 },
        select: { userId: true },
      }),
    ]);

    if (platformAdministrator?.userId === userId) {
      return true;
    }

    if (!membership) {
      throw groupNotFound();
    }

    if (membership.role !== OrganizationRole.ADMIN) {
      throw new AuthError(403, "Forbidden");
    }

    return false;
  }

  async function requireGroup(groupId: string, organizationId: string) {
    const group = await prisma.group.findFirst({
      where: { id: groupId, organizationId },
      include: groupInclude,
    });

    if (!group) {
      throw groupNotFound();
    }

    return group;
  }

  return {
    async listGroups(userId) {
      const groups = await prisma.group.findMany({
        where: { memberships: { some: { userId } } },
        orderBy: [
          { organization: { name: "asc" } },
          { name: "asc" },
          { id: "asc" },
        ],
        include: groupInclude,
      });

      return groups.map(toGroupResponse);
    },
    async createGroup(userId, organizationId, input) {
      const isPlatformAdministrator = await requireAdmin(
        userId,
        organizationId,
      );
      const group = await prisma.group.create({
        data: isPlatformAdministrator
          ? { ...input, organizationId }
          : {
              ...input,
              organizationId,
              memberships: {
                create: {
                  user: { connect: { id: userId } },
                  organizationMembership: {
                    connect: {
                      userId_organizationId: { userId, organizationId },
                    },
                  },
                },
              },
            },
        include: groupInclude,
      });

      return toGroupResponse(group);
    },
    async updateGroup(userId, organizationId, groupId, input) {
      await requireAdmin(userId, organizationId);
      await requireGroup(groupId, organizationId);
      const group = await prisma.group.update({
        where: { id: groupId },
        data: input,
        include: groupInclude,
      });

      return toGroupResponse(group);
    },
    async deleteGroup(userId, organizationId, groupId) {
      await requireAdmin(userId, organizationId);
      await requireGroup(groupId, organizationId);
      await prisma.$transaction([
        prisma.groupMembership.deleteMany({ where: { groupId } }),
        prisma.group.delete({ where: { id: groupId } }),
      ]);
    },
    async addMember(userId, organizationId, groupId, memberId) {
      await requireAdmin(userId, organizationId);
      await requireGroup(groupId, organizationId);

      const member = await prisma.organizationMembership.findUnique({
        where: {
          userId_organizationId: { userId: memberId, organizationId },
        },
        select: { userId: true },
      });
      if (!member) {
        throw groupNotFound();
      }

      try {
        await prisma.groupMembership.create({
          data: { groupId, userId: member.userId, organizationId },
        });
      } catch (error) {
        if ((error as { code?: unknown }).code === "P2002") {
          throw new AuthError(409, "Group membership already exists");
        }

        throw error;
      }

      return toGroupResponse(await requireGroup(groupId, organizationId));
    },
    async removeMember(userId, organizationId, groupId, memberId) {
      await requireAdmin(userId, organizationId);
      await requireGroup(groupId, organizationId);
      const result = await prisma.groupMembership.deleteMany({
        where: { groupId, userId: memberId },
      });

      if (result.count !== 1) {
        throw groupNotFound();
      }
    },
  };
}
