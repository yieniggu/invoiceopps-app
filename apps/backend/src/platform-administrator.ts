import {
  PlatformAdministrativeAuditEventType,
  type PrismaClient,
} from "./generated/prisma/client.js";
import { AuthError } from "./auth.js";

export interface PlatformAdministratorService {
  transfer(userId: string): Promise<void>;
}

export function createPlatformAdministratorService(
  prisma: PrismaClient,
): PlatformAdministratorService {
  return {
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
  };
}
