import {
  OrganizationRole,
  PlatformAdministrativeAuditEventType,
  type Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import { formatRut } from "../../rut.js";
import { runSerializable, SERIALIZABLE } from "../../transactions.js";
import { lockUsers } from "../auth/services.js";
import { requirePlatformAdministrator } from "../orgs/authority.js";
import { NO_INVOICE_PERMISSIONS } from "../groups/invoice-permissions.js";
import { provisionUserWithMemberships } from "../users/services.js";
import { getUser, listUsers } from "./directory.js";
import { resetPassword, updateUser } from "./maintenance.js";
import { notFound, requireActionableActor } from "./targets.js";
import type {
  AdminUserCreateRequest,
  AdminUserCreateResponse,
  AdminUserDeactivationResponse,
  AdminUserDetailResponse,
  AdminUserListQuery,
  AdminUserListResponse,
  AdminUserPasswordResetRequest,
  AdminUserPasswordResetResponse,
  AdminUserUpdateRequest,
  AdminUserUpdateResponse,
} from "./types.js";

export interface AdminUserService {
  createUser(
    actorUserId: string,
    input: AdminUserCreateRequest,
  ): Promise<AdminUserCreateResponse>;
  /** Idempotent: `changed` is false when the user was already disabled. */
  deactivateUser(
    actorUserId: string,
    targetUserId: string,
  ): Promise<{ result: AdminUserDeactivationResponse; changed: boolean }>;
  /** Idempotent: `changed` is false when the user was already enabled. */
  reactivateUser(
    actorUserId: string,
    targetUserId: string,
  ): Promise<{ result: AdminUserDeactivationResponse; changed: boolean }>;
  listUsers(
    actorUserId: string,
    query: AdminUserListQuery,
  ): Promise<AdminUserListResponse>;
  getUser(
    actorUserId: string,
    targetUserId: string,
  ): Promise<AdminUserDetailResponse>;
  /** `changed` is false when the request matched the stored values. */
  updateUser(
    actorUserId: string,
    targetUserId: string,
    input: AdminUserUpdateRequest,
  ): Promise<{ result: AdminUserUpdateResponse; changed: boolean }>;
  resetPassword(
    actorUserId: string,
    targetUserId: string,
    input: AdminUserPasswordResetRequest,
  ): Promise<AdminUserPasswordResetResponse>;
}

const userSelect = {
  id: true,
  name: true,
  rut: true,
  disabledAt: true,
} as const;

function toResult(user: {
  id: string;
  name: string;
  rut: string;
  disabledAt: Date | null;
}): AdminUserDeactivationResponse {
  return {
    user: {
      id: user.id,
      name: user.name,
      rut: formatRut(user.rut),
      disabledAt: user.disabledAt?.toISOString() ?? null,
    },
  };
}

/**
 * Lock order (see features/groups/locks.ts): User rows first, in ascending id
 * order and in one statement, so concurrent deactivations of different admins
 * of the same organization serialize instead of both seeing the other as the
 * remaining administrator. Membership rows are only read afterwards; the
 * transaction is SERIALIZABLE, so a concurrent role change or membership
 * removal that invalidates the read aborts one side (retried by
 * runSerializable).
 *
 * The co-administrator set comes from membership reads that must precede the
 * sorted lock, so this one path cannot lock before its first read; the target
 * User row itself is read only after the lock. Taking the lock after the
 * snapshot means a commit on a locked row in between (for example login's
 * lastActiveAt write) aborts this transaction with a serialization failure,
 * which runSerializable retries.
 */
async function lockTargetAndCoAdministrators(
  transaction: Prisma.TransactionClient,
  targetUserId: string,
) {
  const adminOrganizations = await transaction.organizationMembership.findMany({
    where: { userId: targetUserId, role: OrganizationRole.ADMIN },
    select: { organizationId: true },
  });
  const organizationIds = adminOrganizations.map((m) => m.organizationId);
  const coAdministrators = await transaction.organizationMembership.findMany({
    where: {
      organizationId: { in: organizationIds },
      role: OrganizationRole.ADMIN,
      userId: { not: targetUserId },
    },
    select: { userId: true },
  });
  await lockUsers(transaction, [
    targetUserId,
    ...new Set(coAdministrators.map((m) => m.userId)),
  ]);
  return organizationIds;
}

export function createAdminUserService(prisma: PrismaClient): AdminUserService {
  return {
    listUsers: (actorUserId, query) => listUsers(prisma, actorUserId, query),
    getUser: (actorUserId, targetUserId) =>
      getUser(prisma, actorUserId, targetUserId),
    updateUser: (actorUserId, targetUserId, input) =>
      updateUser(prisma, actorUserId, targetUserId, input),
    resetPassword: (actorUserId, targetUserId, input) =>
      resetPassword(prisma, actorUserId, targetUserId, input),

    async createUser(actorUserId, input) {
      const provisioned = await provisionUserWithMemberships(prisma, {
        actorUserId,
        name: input.name,
        rut: input.rut,
        memberships: input.memberships.map((membership) => ({
          organizationId: membership.organizationId,
          role: membership.role,
          permissions: membership.permissions ?? NO_INVOICE_PERMISSIONS,
          groups: (membership.groups ?? []).map((group) => ({
            groupId: group.groupId,
            permissions: group.permissions ?? NO_INVOICE_PERMISSIONS,
          })),
        })),
        authorize: (database) =>
          requirePlatformAdministrator(database, actorUserId),
        scope: "platform",
        definedTemporaryPassword: input.temporaryPassword,
      });
      return {
        user: provisioned.user,
        memberships: provisioned.memberships,
        ...(provisioned.temporaryPassword === undefined
          ? {}
          : { temporaryPassword: provisioned.temporaryPassword }),
      };
    },

    async deactivateUser(actorUserId, targetUserId) {
      return runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await requireActionableActor(
              transaction,
              actorUserId,
              targetUserId,
            );
            const organizationIds = await lockTargetAndCoAdministrators(
              transaction,
              targetUserId,
            );
            const target = await transaction.user.findUnique({
              where: { id: targetUserId },
              select: userSelect,
            });
            if (!target) throw notFound();
            if (target.disabledAt) {
              return { result: toResult(target), changed: false };
            }
            // Every organization the target administers must keep another
            // enabled administrator.
            for (const organizationId of organizationIds) {
              const remaining = await transaction.organizationMembership.count({
                where: {
                  organizationId,
                  role: OrganizationRole.ADMIN,
                  userId: { not: targetUserId },
                  user: { disabledAt: null },
                },
              });
              if (remaining === 0) {
                throw new ApiError(
                  409,
                  "LAST_ADMIN_REQUIRED",
                  "Organization must retain an administrator",
                );
              }
            }
            const at = new Date();
            const updated = await transaction.user.update({
              where: { id: targetUserId },
              data: { disabledAt: at },
              select: userSelect,
            });
            await transaction.session.deleteMany({
              where: { userId: targetUserId },
            });
            await transaction.apiToken.updateMany({
              where: { userId: targetUserId, revokedAt: null },
              data: { revokedAt: at },
            });
            await transaction.platformAdministrativeAuditEvent.create({
              data: {
                type: PlatformAdministrativeAuditEventType.USER_DEACTIVATED,
                actorUserId,
                targetUserId,
              },
            });
            return { result: toResult(updated), changed: true };
          }, SERIALIZABLE),
        undefined,
        "adminUsers.deactivateUser",
      );
    },

    async reactivateUser(actorUserId, targetUserId) {
      return runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await requireActionableActor(
              transaction,
              actorUserId,
              targetUserId,
            );
            await lockUsers(transaction, [targetUserId]);
            const target = await transaction.user.findUnique({
              where: { id: targetUserId },
              select: userSelect,
            });
            if (!target) throw notFound();
            if (!target.disabledAt) {
              return { result: toResult(target), changed: false };
            }
            const updated = await transaction.user.update({
              where: { id: targetUserId },
              data: { disabledAt: null },
              select: userSelect,
            });
            await transaction.platformAdministrativeAuditEvent.create({
              data: {
                type: PlatformAdministrativeAuditEventType.USER_REACTIVATED,
                actorUserId,
                targetUserId,
              },
            });
            return { result: toResult(updated), changed: true };
          }, SERIALIZABLE),
        undefined,
        "adminUsers.reactivateUser",
      );
    },
  };
}
