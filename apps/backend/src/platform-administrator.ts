import {
  OrganizationRole,
  PlatformAdministrativeAuditEventType,
  Prisma,
  type PrismaClient,
} from "./generated/prisma/client.js";
import { AuthError } from "./auth.js";
import type { GroupResponse } from "./groups.js";

const MAX_SERIALIZABLE_RETRIES = 3;

export interface PlatformAdministratorService {
  bootstrap(userId: string): Promise<void>;
  transfer(userId: string): Promise<void>;
  listOrganizations(
    actorUserId: string,
  ): Promise<PlatformOrganizationResponse[]>;
  createMembership(
    actorUserId: string,
    organizationId: string,
    userId: string,
    role: OrganizationRole,
  ): Promise<OrganizationMembershipResponse>;
  changeMembershipRole(
    actorUserId: string,
    organizationId: string,
    userId: string,
    role: OrganizationRole,
  ): Promise<OrganizationMembershipResponse>;
  removeMembership(
    actorUserId: string,
    organizationId: string,
    userId: string,
  ): Promise<void>;
}

export interface OrganizationMembershipResponse {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
}

export interface PlatformOrganizationResponse {
  id: string;
  name: string;
  groups: GroupResponse[];
}

function isTransactionConflict(error: unknown) {
  return (error as { code?: unknown }).code === "P2034";
}

function notFound() {
  return new AuthError(404, "Organization membership not found");
}

export function createPlatformAdministratorService(
  prisma: PrismaClient,
): PlatformAdministratorService {
  async function runSerializable<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < MAX_SERIALIZABLE_RETRIES; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (
          !isTransactionConflict(error) ||
          attempt === MAX_SERIALIZABLE_RETRIES - 1
        ) {
          if (isTransactionConflict(error)) {
            throw new AuthError(409, "Membership update conflicted; retry");
          }
          throw error;
        }
      }
    }

    throw new AuthError(409, "Membership update conflicted; retry");
  }

  async function requirePlatformAdministrator(
    transaction: Prisma.TransactionClient,
    userId: string,
  ) {
    const administrator = await transaction.platformAdministrator.findUnique({
      where: { id: 1 },
      select: { userId: true },
    });

    if (!administrator || administrator.userId !== userId) {
      throw new AuthError(403, "Forbidden");
    }
  }

  async function requireAtLeastOneOtherAdministrator(
    transaction: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
  ) {
    const administrators = await transaction.organizationMembership.count({
      where: { organizationId, role: OrganizationRole.ADMIN },
    });

    if (administrators <= 1) {
      throw new AuthError(409, "Organization must retain an administrator");
    }

    const membership = await transaction.organizationMembership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { role: true },
    });

    if (!membership) {
      throw notFound();
    }
  }

  return {
    async bootstrap(userId) {
      try {
        await prisma.$transaction(async (transaction) => {
          const user = await transaction.user.findUnique({
            where: { id: userId },
            select: { id: true },
          });
          if (!user) {
            throw new AuthError(404, "User not found");
          }

          const administrator =
            await transaction.platformAdministrator.findUnique({
              where: { id: 1 },
              select: { id: true },
            });
          if (administrator) {
            throw new AuthError(409, "Platform administrator already exists");
          }

          await transaction.platformAdministrator.create({
            data: { id: 1, userId },
          });
          await transaction.platformAdministrativeAuditEvent.create({
            data: {
              type: PlatformAdministrativeAuditEventType.PLATFORM_ADMINISTRATOR_BOOTSTRAPPED,
              actorUserId: userId,
              targetUserId: userId,
            },
          });
        });
      } catch (error) {
        if ((error as { code?: unknown }).code === "P2002") {
          throw new AuthError(409, "Platform administrator already exists");
        }
        throw error;
      }
    },
    async transfer(userId) {
      await prisma.$transaction(async (transaction) => {
        const administrator =
          await transaction.platformAdministrator.findUnique({
            where: { id: 1 },
            select: { userId: true },
          });
        if (!administrator) {
          throw new AuthError(404, "Platform administrator not found");
        }
        if (administrator.userId === userId) {
          throw new AuthError(400, "Platform administrator is unchanged");
        }

        const user = await transaction.user.findUnique({
          where: { id: userId },
          select: { id: true },
        });
        if (!user) {
          throw new AuthError(404, "User not found");
        }

        await transaction.platformAdministrator.update({
          where: { id: 1 },
          data: { userId },
        });
        await transaction.platformAdministrativeAuditEvent.create({
          data: {
            type: PlatformAdministrativeAuditEventType.PLATFORM_ADMINISTRATOR_TRANSFERRED,
            actorUserId: administrator.userId,
            targetUserId: userId,
          },
        });
      });
    },
    async listOrganizations(actorUserId) {
      return prisma.$transaction(async (transaction) => {
        await requirePlatformAdministrator(transaction, actorUserId);
        const organizations = await transaction.organization.findMany({
          orderBy: [{ name: "asc" }, { id: "asc" }],
          include: {
            groups: {
              orderBy: [{ name: "asc" }, { id: "asc" }],
              include: {
                memberships: {
                  orderBy: [
                    { user: { name: "asc" } },
                    { user: { rut: "asc" } },
                    { userId: "asc" },
                  ],
                  select: {
                    user: { select: { id: true, name: true, rut: true } },
                  },
                },
              },
            },
          },
        });

        return organizations.map((organization) => ({
          id: organization.id,
          name: organization.name,
          groups: organization.groups.map((group) => ({
            id: group.id,
            name: group.name,
            description: group.description,
            organization: { id: organization.id, name: organization.name },
            members: group.memberships.map(({ user }) => user),
          })),
        }));
      });
    },
    async createMembership(actorUserId, organizationId, userId, role) {
      return runSerializable(() =>
        prisma.$transaction(
          async (transaction) => {
            await requirePlatformAdministrator(transaction, actorUserId);
            const [user, organization] = await Promise.all([
              transaction.user.findUnique({
                where: { id: userId },
                select: { id: true },
              }),
              transaction.organization.findUnique({
                where: { id: organizationId },
                select: { id: true },
              }),
            ]);
            if (!user || !organization) {
              throw notFound();
            }

            try {
              const membership =
                await transaction.organizationMembership.create({
                  data: { userId, organizationId, role },
                  select: { userId: true, organizationId: true, role: true },
                });
              await transaction.platformAdministrativeAuditEvent.create({
                data: {
                  type: PlatformAdministrativeAuditEventType.ORGANIZATION_MEMBERSHIP_CREATED,
                  actorUserId,
                  targetUserId: userId,
                  organizationId,
                  role,
                },
              });
              return membership;
            } catch (error) {
              if ((error as { code?: unknown }).code === "P2002") {
                throw new AuthError(
                  409,
                  "Organization membership already exists",
                );
              }
              throw error;
            }
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
    },
    async changeMembershipRole(actorUserId, organizationId, userId, role) {
      return runSerializable(() =>
        prisma.$transaction(
          async (transaction) => {
            await requirePlatformAdministrator(transaction, actorUserId);
            const membership =
              await transaction.organizationMembership.findUnique({
                where: { userId_organizationId: { userId, organizationId } },
                select: { role: true },
              });
            if (!membership) {
              throw notFound();
            }
            if (membership.role === role) {
              return { userId, organizationId, role };
            }
            if (membership.role === OrganizationRole.ADMIN) {
              await requireAtLeastOneOtherAdministrator(
                transaction,
                organizationId,
                userId,
              );
            }

            const updated = await transaction.organizationMembership.update({
              where: { userId_organizationId: { userId, organizationId } },
              data: { role },
              select: { userId: true, organizationId: true, role: true },
            });
            await transaction.platformAdministrativeAuditEvent.create({
              data: {
                type: PlatformAdministrativeAuditEventType.ORGANIZATION_MEMBERSHIP_ROLE_CHANGED,
                actorUserId,
                targetUserId: userId,
                organizationId,
                previousRole: membership.role,
                role,
              },
            });
            return updated;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
    },
    async removeMembership(actorUserId, organizationId, userId) {
      await runSerializable(() =>
        prisma.$transaction(
          async (transaction) => {
            await requirePlatformAdministrator(transaction, actorUserId);
            const membership =
              await transaction.organizationMembership.findUnique({
                where: { userId_organizationId: { userId, organizationId } },
                select: { role: true },
              });
            if (!membership) {
              throw notFound();
            }
            if (membership.role === OrganizationRole.ADMIN) {
              await requireAtLeastOneOtherAdministrator(
                transaction,
                organizationId,
                userId,
              );
            }

            await transaction.groupMembership.deleteMany({
              where: { userId, organizationId },
            });
            await transaction.organizationMembership.delete({
              where: { userId_organizationId: { userId, organizationId } },
            });
            await transaction.platformAdministrativeAuditEvent.create({
              data: {
                type: PlatformAdministrativeAuditEventType.ORGANIZATION_MEMBERSHIP_REMOVED,
                actorUserId,
                targetUserId: userId,
                organizationId,
                previousRole: membership.role,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
    },
  };
}
