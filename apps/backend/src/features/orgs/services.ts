import {
  OrganizationRole,
  PlatformAdministrativeAuditEventType,
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import { escapeLike, pageWindow, type PageQuery } from "../../pagination.js";
import {
  isUniqueViolation,
  runSerializable,
  SERIALIZABLE,
} from "../../transactions.js";
import { isRecentlyActive } from "../auth/services.js";
import {
  lockMembershipCascadeForUpdate,
  lockOrganizationMembershipForUpdate,
  lockOrganizationMembershipsForUpdate,
} from "../groups/locks.js";
import {
  NO_INVOICE_PERMISSIONS,
  PERMISSION_SELECT,
  permissionsOf,
  type InvoicePermissions,
} from "../groups/invoice-permissions.js";
import {
  auditGroupMembershipsRemoved,
  auditPermissionsChanged,
} from "../groups/membership-audit.js";
import {
  isPlatformAdministrator,
  organizationGroupVisibility,
  resolveGroupVisibility,
  requireOrganizationAdmin,
} from "./authority.js";
import type {
  MembershipDto,
  MembershipListResponse,
  OrganizationBasicDto,
  OrganizationCountsDto,
  OrganizationCreateRequest,
  OrganizationDto,
  OrganizationListQuery,
  OrganizationListResponse,
  OrganizationMemberListResponse,
  OrganizationUpdateRequest,
} from "./types.js";

/** One snapshot for the count and the page, so total matches the rows. */
const SNAPSHOT = { isolationLevel: "RepeatableRead" } as const;

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
  ...PERMISSION_SELECT,
} satisfies Prisma.OrganizationMembershipSelect;

function toMembershipDto(row: {
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  readInvoices: boolean;
  createInvoices: boolean;
  deleteOwnInvoices: boolean;
  deleteOthersInvoices: boolean;
}): MembershipDto {
  return {
    userId: row.userId,
    organizationId: row.organizationId,
    role: row.role,
    permissions: permissionsOf(row),
  };
}

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
  listOrganizations(
    actorUserId: string,
    query: OrganizationListQuery,
  ): Promise<OrganizationListResponse>;
  createOrganization(
    actorUserId: string,
    input: OrganizationCreateRequest,
  ): Promise<{ organization: OrganizationDto; membership: MembershipDto }>;
  getOrganization(
    actorUserId: string,
    organizationId: string,
  ): Promise<{
    organization: OrganizationBasicDto;
    summary: OrganizationCountsDto;
  }>;
  updateOrganization(
    actorUserId: string,
    organizationId: string,
    input: OrganizationUpdateRequest,
  ): Promise<{ organization: OrganizationBasicDto; changed: boolean }>;
  listMembers(
    actorUserId: string,
    organizationId: string,
    query: PageQuery,
  ): Promise<OrganizationMemberListResponse>;
  listMemberships(
    actorUserId: string,
    organizationId: string,
    query: PageQuery & { userIds?: string[] },
  ): Promise<MembershipListResponse>;
  createMembership(
    actorUserId: string,
    organizationId: string,
    input: {
      rut: string;
      role: OrganizationRole;
      permissions?: InvoicePermissions;
    },
  ): Promise<MembershipDto>;
  changeMembershipRole(
    actorUserId: string,
    organizationId: string,
    userId: string,
    role: OrganizationRole,
  ): Promise<{ membership: MembershipDto; changed: boolean }>;
  updateMembershipPermissions(
    actorUserId: string,
    organizationId: string,
    userId: string,
    permissions: InvoicePermissions,
  ): Promise<MembershipDto>;
  updateMembershipsPermissions(
    actorUserId: string,
    organizationId: string,
    userIds: string[],
    permissions: InvoicePermissions,
  ): Promise<MembershipDto[]>;
  removeMembership(
    actorUserId: string,
    organizationId: string,
    userId: string,
  ): Promise<void>;
}

export function createOrganizationService(
  prisma: PrismaClient,
): OrganizationService {
  // A disabled administrator cannot act, so only enabled ones count.
  async function requireOtherAdministrator(
    transaction: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
  ) {
    const others = await transaction.organizationMembership.count({
      where: {
        organizationId,
        role: OrganizationRole.ADMIN,
        userId: { not: userId },
        user: { disabledAt: null },
      },
    });
    if (others === 0) {
      throw new ApiError(
        409,
        "LAST_ADMIN_REQUIRED",
        "Organization must retain an administrator",
      );
    }
  }

  return {
    async listOrganizations(actorUserId, query) {
      return runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            const all = await isPlatformAdministrator(transaction, actorUserId);
            const where: Prisma.OrganizationWhereInput = {
              ...(all
                ? {}
                : { memberships: { some: { userId: actorUserId } } }),
              ...(query.search === undefined
                ? {}
                : {
                    name: {
                      contains: escapeLike(query.search),
                      mode: "insensitive",
                    },
                  }),
            };
            const total = await transaction.organization.count({ where });
            const organizations = await transaction.organization.findMany({
              where,
              orderBy: [{ name: "asc" }, { id: "asc" }],
              ...pageWindow(query),
              select: ORGANIZATION_SELECT,
            });
            return {
              organizations: organizations.map(toOrganizationDto),
              page: query.page,
              pageSize: query.pageSize,
              total,
            };
          }, SNAPSHOT),
        undefined,
        "organization_list",
      );
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
              ...NO_INVOICE_PERMISSIONS,
              actorIsTarget: actorUserId === firstAdmin.id,
            },
          ],
        });
        return {
          organization: toOrganizationDto(organization),
          membership: toMembershipDto(membership),
        };
      });
    },

    async getOrganization(actorUserId, organizationId) {
      // Any member or the platform administrator; everybody else gets 404.
      // One snapshot, and the same visibility rule as GET .../groups, so the
      // group count always equals the length of that list.
      const organization = await runSerializable(
        () =>
          prisma.$transaction(
            async (transaction) => {
              const visibility = await resolveGroupVisibility(
                transaction,
                actorUserId,
                organizationId,
              );
              // One query: both counts come with the organization (no N+1).
              return transaction.organization.findUnique({
                where: { id: organizationId },
                select: {
                  id: true,
                  name: true,
                  slug: true,
                  description: true,
                  _count: {
                    select: {
                      memberships: true,
                      groups:
                        visibility === "all"
                          ? true
                          : {
                              where: {
                                memberships: { some: { userId: actorUserId } },
                              },
                            },
                    },
                  },
                },
              });
            },
            { isolationLevel: "RepeatableRead" },
          ),
        undefined,
        "organization_get",
      );
      if (!organization) throw new ApiError(404, "NOT_FOUND", "Not found");
      const { _count, ...basic } = organization;
      return {
        organization: basic,
        summary: { memberCount: _count.memberships, groupCount: _count.groups },
      };
    },

    async updateOrganization(actorUserId, organizationId, input) {
      return runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await requireOrganizationAdmin(
              transaction,
              actorUserId,
              organizationId,
            );
            const current = await transaction.organization.findUnique({
              where: { id: organizationId },
              select: { id: true, name: true, slug: true, description: true },
            });
            if (!current) throw new ApiError(404, "NOT_FOUND", "Not found");
            const data = {
              ...(input.name !== undefined && input.name !== current.name
                ? { name: input.name }
                : {}),
              ...(input.description !== undefined &&
              input.description !== current.description
                ? { description: input.description }
                : {}),
            };
            // Nothing differs: nothing is written or audited.
            if (Object.keys(data).length === 0)
              return { organization: current, changed: false };

            const organization = await transaction.organization.update({
              where: { id: organizationId },
              data,
              select: { id: true, name: true, slug: true, description: true },
            });
            await transaction.platformAdministrativeAuditEvent.create({
              data: {
                type: PlatformAdministrativeAuditEventType.ORGANIZATION_UPDATED,
                actorUserId,
                organizationId,
              },
            });
            return { organization, changed: true };
          }, SERIALIZABLE),
        undefined,
        "organizations.updateOrganization",
      );
    },

    // Reduced view for every caller (no RUT, no disabled flag); the ADMIN and
    // platform view with `disabled` is listMemberships (/memberships).
    async listMembers(actorUserId, organizationId, query) {
      return runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            // Any member or the platform administrator; everybody else gets 404.
            await organizationGroupVisibility(
              transaction,
              actorUserId,
              organizationId,
            );
            const where = { organizationId };
            const total = await transaction.organizationMembership.count({
              where,
            });
            const rows = await transaction.organizationMembership.findMany({
              where,
              orderBy: [{ user: { name: "asc" } }, { userId: "asc" }],
              ...pageWindow(query),
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    lastActiveAt: true,
                    disabledAt: true,
                  },
                },
              },
            });
            return {
              members: rows.map(({ user }) => ({
                userId: user.id,
                name: user.name,
                email: user.email,
                recentlyActive: isRecentlyActive(
                  user.lastActiveAt,
                  user.disabledAt,
                ),
              })),
              page: query.page,
              pageSize: query.pageSize,
              total,
            };
          }, SNAPSHOT),
        undefined,
        "organization_members_list",
      );
    },

    async listMemberships(actorUserId, organizationId, query) {
      return runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await requireOrganizationAdmin(
              transaction,
              actorUserId,
              organizationId,
            );
            const where = {
              organizationId,
              ...(query.userIds ? { userId: { in: query.userIds } } : {}),
            };
            const total = await transaction.organizationMembership.count({
              where,
            });
            // One query: group names come with the memberships (no N+1).
            const memberships =
              await transaction.organizationMembership.findMany({
                where,
                orderBy: [
                  { user: { name: "asc" } },
                  { user: { rut: "asc" } },
                  { userId: "asc" },
                ],
                ...pageWindow(query),
                select: {
                  ...MEMBERSHIP_SELECT,
                  user: {
                    select: {
                      id: true,
                      name: true,
                      rut: true,
                      lastActiveAt: true,
                      disabledAt: true,
                    },
                  },
                  groupMemberships: {
                    orderBy: [{ group: { name: "asc" } }, { groupId: "asc" }],
                    select: {
                      ...PERMISSION_SELECT,
                      group: { select: { id: true, name: true } },
                    },
                  },
                },
              });
            return {
              memberships: memberships.map(
                ({ user, groupMemberships, ...membership }) => ({
                  ...toMembershipDto(membership),
                  user: {
                    id: user.id,
                    name: user.name,
                    rut: user.rut,
                    disabled: user.disabledAt !== null,
                    recentlyActive: isRecentlyActive(
                      user.lastActiveAt,
                      user.disabledAt,
                    ),
                  },
                  groups: groupMemberships.map(({ group, ...flags }) => ({
                    groupId: group.id,
                    name: group.name,
                    permissions: permissionsOf(flags),
                  })),
                }),
              ),
              page: query.page,
              pageSize: query.pageSize,
              total,
            };
          }, SNAPSHOT),
        undefined,
        "organization_memberships_list",
      );
    },

    async createMembership(actorUserId, organizationId, input) {
      return runSerializable(
        () =>
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
              const membership =
                await transaction.organizationMembership.create({
                  data: {
                    userId: user.id,
                    organizationId,
                    role: input.role,
                    ...(input.permissions ?? NO_INVOICE_PERMISSIONS),
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
                  ...permissionsOf(membership),
                  actorIsTarget: actorUserId === user.id,
                },
              });
              return toMembershipDto(membership);
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
        undefined,
        "organizations.createMembership",
      );
    },

    async changeMembershipRole(actorUserId, organizationId, userId, role) {
      return runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await requireOrganizationAdmin(
              transaction,
              actorUserId,
              organizationId,
            );
            await lockMembershipCascadeForUpdate(transaction, {
              userId,
              organizationId,
            });
            const membership =
              await transaction.organizationMembership.findUnique({
                where: { userId_organizationId: { userId, organizationId } },
                select: MEMBERSHIP_SELECT,
              });
            if (!membership) throw membershipNotFound();
            // Same role: nothing is written, so callers must not report a change.
            if (membership.role === role)
              return {
                membership: toMembershipDto(membership),
                changed: false,
              };
            if (membership.role === OrganizationRole.ADMIN) {
              await requireOtherAdministrator(
                transaction,
                organizationId,
                userId,
              );
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
                actorIsTarget: actorUserId === userId,
              },
            });
            return { membership: toMembershipDto(updated), changed: true };
          }, SERIALIZABLE),
        undefined,
        "organizations.changeMembershipRole",
      );
    },

    async updateMembershipPermissions(
      actorUserId,
      organizationId,
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
            const locked = await lockOrganizationMembershipForUpdate(
              transaction,
              { userId, organizationId },
            );
            if (!locked) throw membershipNotFound();
            const updated = await transaction.organizationMembership.update({
              where: { userId_organizationId: { userId, organizationId } },
              data: permissions,
              select: MEMBERSHIP_SELECT,
            });
            await auditPermissionsChanged(
              transaction,
              { actorUserId, organizationId },
              [{ userId, permissions }],
            );
            return toMembershipDto(updated);
          }, SERIALIZABLE),
        undefined,
        "organizations.updateMembershipPermissions",
      );
    },

    async updateMembershipsPermissions(
      actorUserId,
      organizationId,
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
            // Every membership FOR UPDATE in id order (the single PUT is the
            // one-element case of this order). All or nothing: a user who is
            // not a member aborts the transaction before any write.
            const locked = await lockOrganizationMembershipsForUpdate(
              transaction,
              { organizationId, userIds },
            );
            if (locked.length !== userIds.length) throw membershipNotFound();
            await transaction.organizationMembership.updateMany({
              where: { organizationId, userId: { in: userIds } },
              data: permissions,
            });
            await auditPermissionsChanged(
              transaction,
              { actorUserId, organizationId },
              userIds.map((id) => ({ userId: id, permissions })),
            );
            const rows = await transaction.organizationMembership.findMany({
              where: { organizationId, userId: { in: userIds } },
              select: MEMBERSHIP_SELECT,
            });
            const byUser = new Map(rows.map((row) => [row.userId, row]));
            return userIds.map((id) => toMembershipDto(byUser.get(id)!));
          }, SERIALIZABLE),
        undefined,
        "organizations.updateMembershipsPermissions",
      );
    },

    async removeMembership(actorUserId, organizationId, userId) {
      await runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await requireOrganizationAdmin(
              transaction,
              actorUserId,
              organizationId,
            );
            // Organization membership first, then this user's group memberships
            // in id order: removal serializes with permission and membership
            // changes of that user.
            await lockMembershipCascadeForUpdate(transaction, {
              userId,
              organizationId,
            });
            const membership =
              await transaction.organizationMembership.findUnique({
                where: { userId_organizationId: { userId, organizationId } },
                select: { role: true },
              });
            if (!membership) throw membershipNotFound();
            if (membership.role === OrganizationRole.ADMIN) {
              await requireOtherAdministrator(
                transaction,
                organizationId,
                userId,
              );
            }

            // The cascade is audited per group: the rows are locked above, so
            // the list below is exactly what the delete removes.
            const removedGroups = await transaction.groupMembership.findMany({
              where: { userId, organizationId },
              orderBy: { groupId: "asc" },
              select: { groupId: true },
            });
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
                actorIsTarget: actorUserId === userId,
              },
            });
            await auditGroupMembershipsRemoved(
              transaction,
              { actorUserId, organizationId },
              removedGroups.map(({ groupId }) => ({ userId, groupId })),
            );
          }, SERIALIZABLE),
        undefined,
        "organizations.removeMembership",
      );
    },
  };
}
