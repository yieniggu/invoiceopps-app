import {
  PlatformAdministrativeAuditEventType,
  type Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import {
  isUniqueViolation,
  runSerializable,
  SERIALIZABLE,
} from "../../transactions.js";
import { lockUser } from "../auth/services.js";
import { requirePlatformAdministrator } from "../orgs/authority.js";
import {
  prepareTemporaryCredential,
  temporaryPasswordExpiry,
} from "../users/temporary-password.js";
import { detailUserSelect, toDetailUser } from "./directory.js";
import {
  notFound,
  requireActionableActor,
  requireActionableTarget,
  selfActionForbidden,
} from "./targets.js";
import type {
  AdminUserPasswordResetRequest,
  AdminUserPasswordResetResponse,
  AdminUserUpdateRequest,
  AdminUserUpdateResponse,
} from "./types.js";

/**
 * Credentials issued before a RUT or password change must stop working. No
 * endpoint creates ApiTokens yet; the Bearer middleware that will accept them
 * must check both `revokedAt` and `user.disabledAt`.
 */
async function revokeCredentials(
  transaction: Prisma.TransactionClient,
  userId: string,
  at: Date,
) {
  await transaction.session.deleteMany({ where: { userId } });
  await transaction.apiToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: at },
  });
}

/**
 * Name and RUT change under the target's user lock (the same lock login takes),
 * so a login cannot create a session between the RUT change and the
 * revocation. A RUT change revokes sessions and API tokens.
 */
export function updateUser(
  prisma: PrismaClient,
  actorUserId: string,
  targetUserId: string,
  input: AdminUserUpdateRequest,
): Promise<{ result: AdminUserUpdateResponse; changed: boolean }> {
  return runSerializable(
    () =>
      prisma.$transaction(async (transaction) => {
        await requirePlatformAdministrator(transaction, actorUserId);
        await lockUser(transaction, targetUserId);
        const target = await transaction.user.findUnique({
          where: { id: targetUserId },
          select: detailUserSelect,
        });
        if (!target) throw notFound();

        const nameChanged =
          input.name !== undefined && input.name !== target.name;
        const rutChanged = input.rut !== undefined && input.rut !== target.rut;
        if (rutChanged && actorUserId === targetUserId) {
          throw selfActionForbidden();
        }
        if (!nameChanged && !rutChanged) {
          return { result: { user: toDetailUser(target) }, changed: false };
        }

        let updated;
        try {
          updated = await transaction.user.update({
            where: { id: targetUserId },
            data: {
              ...(nameChanged ? { name: input.name } : {}),
              ...(rutChanged ? { rut: input.rut } : {}),
            },
            select: detailUserSelect,
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ApiError(409, "USER_CONFLICT", "User already exists");
          }
          throw error;
        }
        if (rutChanged) {
          await revokeCredentials(transaction, targetUserId, new Date());
        }
        await transaction.platformAdministrativeAuditEvent.create({
          data: {
            type: PlatformAdministrativeAuditEventType.USER_UPDATED,
            actorUserId,
            targetUserId,
            actorIsTarget: actorUserId === targetUserId,
          },
        });
        return { result: { user: toDetailUser(updated) }, changed: true };
      }, SERIALIZABLE),
    undefined,
    "adminUsers.updateUser",
  );
}

/**
 * Replaces the credential with a temporary password (generated unless the
 * administrator defines one), forces a change at next login and revokes every
 * session and API token. The scrypt hash is computed before the transaction;
 * the write runs under the target's user lock, which login also takes, so no
 * login with the old credential can leave a session behind.
 */
export async function resetPassword(
  prisma: PrismaClient,
  actorUserId: string,
  targetUserId: string,
  input: AdminUserPasswordResetRequest,
): Promise<AdminUserPasswordResetResponse> {
  // Cheap checks first: scrypt must not run for outsiders, the actor
  // themselves or an unknown user.
  await requireActionableTarget(prisma, actorUserId, targetUserId);
  const { passwordHash, generatedPassword } = await prepareTemporaryCredential(
    input.temporaryPassword,
  );

  const expiresAt = await runSerializable(
    () =>
      prisma.$transaction(async (transaction) => {
        // Lock first, then read the target (the same lock login takes).
        await requireActionableActor(transaction, actorUserId, targetUserId);
        await lockUser(transaction, targetUserId);
        const target = await transaction.user.findUnique({
          where: { id: targetUserId },
          select: { id: true },
        });
        if (!target) throw notFound();
        const expiry = temporaryPasswordExpiry();
        await transaction.user.update({
          where: { id: targetUserId },
          data: {
            passwordHash,
            mustChangePassword: true,
            temporaryPasswordExpiresAt: expiry,
          },
        });
        await revokeCredentials(transaction, targetUserId, new Date());
        await transaction.platformAdministrativeAuditEvent.create({
          data: {
            type: PlatformAdministrativeAuditEventType.PASSWORD_RESET,
            actorUserId,
            targetUserId,
          },
        });
        return expiry;
      }, SERIALIZABLE),
    undefined,
    "adminUsers.resetPassword",
  );

  return {
    ...(generatedPassword === undefined
      ? {}
      : { temporaryPassword: generatedPassword }),
    expiresAt: expiresAt.toISOString(),
  };
}
