import type { PrismaClient } from "../../generated/prisma/client.js";
import { requirePlatformAdministrator } from "../orgs/authority.js";
import { NO_INVOICE_PERMISSIONS } from "../groups/invoice-permissions.js";
import { provisionUserWithMemberships } from "../users/services.js";
import type {
  AdminUserCreateRequest,
  AdminUserCreateResponse,
} from "./types.js";

export interface AdminUserService {
  createUser(
    actorUserId: string,
    input: AdminUserCreateRequest,
  ): Promise<AdminUserCreateResponse>;
}

export function createAdminUserService(prisma: PrismaClient): AdminUserService {
  return {
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
  };
}
