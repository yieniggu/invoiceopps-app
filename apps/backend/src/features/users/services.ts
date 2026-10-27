import { randomBytes } from "node:crypto";

import {
  PlatformAdministrativeAuditEventType,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { hashPassword } from "../../auth.js";
import { ApiError } from "../../http/errors.js";
import { isUniqueViolation } from "../../transactions.js";
import { requireOrganizationAdmin } from "../orgs/authority.js";
import type {
  OrganizationUserDto,
  UserProvisionRequest,
  UserProvisionResponse,
} from "./types.js";

const TEMPORARY_PASSWORD_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface UserService {
  listUsers(
    actorUserId: string,
    organizationId: string,
  ): Promise<OrganizationUserDto[]>;
  provisionUser(
    actorUserId: string,
    organizationId: string,
    input: UserProvisionRequest,
  ): Promise<UserProvisionResponse>;
}

export function createUserService(prisma: PrismaClient): UserService {
  return {
    async listUsers(actorUserId, organizationId) {
      await requireOrganizationAdmin(prisma, actorUserId, organizationId);
      const memberships = await prisma.organizationMembership.findMany({
        where: { organizationId },
        orderBy: [
          { user: { name: "asc" } },
          { user: { rut: "asc" } },
          { userId: "asc" },
        ],
        select: {
          role: true,
          user: { select: { id: true, name: true, rut: true } },
        },
      });
      return memberships.map(({ role, user }) => ({ ...user, role }));
    },

    async provisionUser(actorUserId, organizationId, input) {
      // Authority first: scrypt is expensive and must not run for outsiders.
      await requireOrganizationAdmin(prisma, actorUserId, organizationId);
      const temporaryPassword = randomBytes(24).toString("base64url");
      const passwordHash = await hashPassword(temporaryPassword);

      return prisma.$transaction(async (transaction) => {
        await requireOrganizationAdmin(
          transaction,
          actorUserId,
          organizationId,
        );
        try {
          const user = await transaction.user.create({
            data: {
              name: input.name,
              rut: input.rut,
              passwordHash,
              mustChangePassword: true,
              temporaryPasswordExpiresAt: new Date(
                Date.now() + TEMPORARY_PASSWORD_LIFETIME_MS,
              ),
              memberships: { create: { organizationId, role: input.role } },
            },
            select: { id: true, name: true, rut: true },
          });
          await transaction.platformAdministrativeAuditEvent.create({
            data: {
              type: PlatformAdministrativeAuditEventType.USER_PROVISIONED,
              actorUserId,
              targetUserId: user.id,
              organizationId,
              role: input.role,
            },
          });
          return {
            user: { ...user, mustChangePassword: true },
            membership: { userId: user.id, organizationId, role: input.role },
            temporaryPassword,
          };
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ApiError(409, "USER_CONFLICT", "User already exists");
          }
          throw error;
        }
      });
    },
  };
}
