import {
  OrganizationRole,
  PlatformAdministrativeAuditEventType,
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import { isUniqueViolation, runSerializable } from "../../transactions.js";
import { lockOrganizationGroups } from "../groups/locks.js";
import { requireOrganizationAdmin } from "./authority.js";
import type {
  MembershipDto,
  MembershipWithUserDto,
  OrganizationCreateRequest,
  OrganizationDto,
} from "./types.js";

const SERIALIZABLE = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;

const ORGANIZATION_SELECT = {
  id: true,
  name: true,
  slug: true,
  description: true,
  enabled: true,
  createdAt: true,
} satisfies Prisma.OrganizationSelect;

const MEMBERSHIP_SELECT = {
  userId: true,
  organizationId: true,
  role: true,
} satisfies Prisma.OrganizationMembershipSelect;

function toOrganizationDto(organization: {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  enabled: boolean;
  createdAt: Date;
}): OrganizationDto {
  return { ...organization, createdAt: organization.createdAt.toISOString() };
}

function membershipNotFound() {
  return new ApiError(404, "NOT_FOUND", "Membership not found");
}

function userNotFound() {
  return new ApiError(404, "USER_NOT_FOUND", "User not found");
}

export interface OrganizationService {
  listOrganizations(actorUserId: string): Promise<OrganizationDto[]>;
  createOrganization(
    actorUserId: string,
    input: OrganizationCreateRequest,
  ): Promise<{ organization: OrganizationDto; membership: MembershipDto }>;
  listMemberships(
    actorUserId: string,
    organizationId: string,
  ): Promise<MembershipWithUserDto[]>;
  createMembership(
    actorUserId: string,
    organizationId: string,
    input: { rut: string; role: OrganizationRole },
  ): Promise<MembershipDto>;
  changeMembershipRole(
    actorUserId: string,
    organizationId: string,
    userId: string,
    role: OrganizationRole,
  ): Promise<{ membership: MembershipDto; changed: boolean }>;
  removeMembership(
    actorUserId: string,
    organizationId: string,
    userId: string,
  ): Promise<void>;
}

export function createOrganizationService(
  prisma: PrismaClient,
): OrganizationService {
  async function isPlatformAdministrator(
    database: Prisma.TransactionClient,
    userId: string,
  ) {
    const administrator = await database.platformAdministrator.findUnique({
      where: { id: 1 },
      select: { userId: true },
    });
    return administrator?.userId === userId;
  }

  async function requireOtherAdministrator(
    transaction: Prisma.TransactionClient,
    organizationId: string,
  ) {
    const administrators = await transaction.organizationMembership.count({
      where: { organizationId, role: OrganizationRole.ADMIN },
    });
    if (administrators <= 1) {
      throw new ApiError(
        409,
        "LAST_ADMIN_REQUIRED",
        "Organization must retain an administrator",
      );
    }
  }

  return {
    async listOrganizations(actorUserId) {
      const all = await isPlatformAdministrator(prisma, actorUserId);
      const organizations = await prisma.organization.findMany({
        where: all ? {} : { memberships: { some: { userId: actorUserId } } },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: ORGANIZATION_SELECT,
      });
      return organizations.map(toOrganizationDto);
    },

    async createOrganization(actorUserId, input) {
      return prisma.$transaction(async (transaction) => {
        if (!(await isPlatformAdministrator(transaction, actorUserId))) {
          throw new ApiError(403, "FORBIDDEN", "Forbidden");
        }
        const firstAdmin = await transaction.user.findUnique({
          where: { rut: input.firstAdminRut },
          select: { id: true },
        });
        if (!firstAdmin) throw userNotFound();

        let organization;
        try {
          organization = await transaction.organization.create({
            data: {
              name: input.name,
              slug: input.slug,
              description: input.description,
            },
            select: ORGANIZATION_SELECT,
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ApiError(
              409,
              "ORGANIZATION_SLUG_CONFLICT",
              "Organization slug already exists",
            );
          }
          throw error;
        }
        const membership = await transaction.organizationMembership.create({
          data: {
            userId: firstAdmin.id,
            organizationId: organization.id,
            role: OrganizationRole.ADMIN,
          },
          select: MEMBERSHIP_SELECT,
        });
        await transaction.platformAdministrativeAuditEvent.createMany({
          data: [
            {
              type: PlatformAdministrativeAuditEventType.ORGANIZATION_CREATED,
              actorUserId,
              organizationId: organization.id,
            },
            {
              type: PlatformAdministrativeAuditEventType.ORGANIZATION_MEMBERSHIP_CREATED,
              actorUserId,
              targetUserId: firstAdmin.id,
              organizationId: organization.id,
              role: OrganizationRole.ADMIN,
            },
          ],
        });
        return { organization: toOrganizationDto(organization), membership };
      });
    },

    async listMemberships(actorUserId, organizationId) {
      await requireOrganizationAdmin(prisma, actorUserId, organizationId);
      return prisma.organizationMembership.findMany({
        where: { organizationId },
        orderBy: [
          { user: { name: "asc" } },
          { user: { rut: "asc" } },
          { userId: "asc" },
        ],
        select: {
          ...MEMBERSHIP_SELECT,
          user: { select: { id: true, name: true, rut: true } },
        },
      });
    },

    async createMembership(actorUserId, organizationId, input) {
      return runSerializable(() =>
        prisma.$transaction(async (transaction) => {
          await requireOrganizationAdmin(
            transaction,
            actorUserId,
            organizationId,
          );
          const user = await transaction.user.findUnique({
            where: { rut: input.rut },
            select: { id: true },
          });
          if (!user) throw userNotFound();

          try {
            const membership = await transaction.organizationMembership.create({
              data: {
                userId: user.id,
                organizationId,
                role: input.role,
              },
              select: MEMBERSHIP_SELECT,
            });
            await transaction.platformAdministrativeAuditEvent.create({
              data: {
                type: PlatformAdministrativeAuditEventType.ORGANIZATION_MEMBERSHIP_CREATED,
                actorUserId,
                targetUserId: user.id,
                organizationId,
                role: input.role,
              },
            });
            return membership;
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw new ApiError(
                409,
                "MEMBERSHIP_CONFLICT",
                "Organization membership already exists",
              );
            }
            throw error;
          }
        }, SERIALIZABLE),
      );
    },

    async changeMembershipRole(actorUserId, organizationId, userId, role) {
      return runSerializable(() =>
        prisma.$transaction(async (transaction) => {
          await requireOrganizationAdmin(
            transaction,
            actorUserId,
            organizationId,
          );
          await lockOrganizationGroups(transaction, organizationId);
          const membership =
            await transaction.organizationMembership.findUnique({
              where: { userId_organizationId: { userId, organizationId } },
              select: { role: true },
            });
          if (!membership) throw membershipNotFound();
          // Same role: nothing is written, so callers must not report a change.
          if (membership.role === role)
            return {
              membership: { userId, organizationId, role },
              changed: false,
            };
          if (membership.role === OrganizationRole.ADMIN) {
            await requireOtherAdministrator(transaction, organizationId);
          }

          const updated = await transaction.organizationMembership.update({
            where: { userId_organizationId: { userId, organizationId } },
            data: { role },
            select: MEMBERSHIP_SELECT,
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
          return { membership: updated, changed: true };
        }, SERIALIZABLE),
      );
    },

    async removeMembership(actorUserId, organizationId, userId) {
      await runSerializable(() =>
        prisma.$transaction(async (transaction) => {
          await requireOrganizationAdmin(
            transaction,
            actorUserId,
            organizationId,
          );
          // Group rows first, in id order, so removal serializes with group
          // configuration and membership changes of this organization.
          await lockOrganizationGroups(transaction, organizationId);
          const membership =
            await transaction.organizationMembership.findUnique({
              where: { userId_organizationId: { userId, organizationId } },
              select: { role: true },
            });
          if (!membership) throw membershipNotFound();
          if (membership.role === OrganizationRole.ADMIN) {
            await requireOtherAdministrator(transaction, organizationId);
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
        }, SERIALIZABLE),
      );
    },
  };
}
