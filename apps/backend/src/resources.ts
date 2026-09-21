import {
  ResourceOwnerType,
  type PrismaClient,
} from "./generated/prisma/client.js";
import { AuthError } from "./auth.js";

export type ResourceContext = {
  organizationId: string;
  ownerType: "user" | "group";
  ownerId: string;
};

export type ResourceResponse = ResourceContext & {
  id: string;
  type: string;
  label: string;
  createdByUserId: string;
};

export interface ResourceService {
  listResources(
    userId: string,
    context: ResourceContext,
  ): Promise<ResourceResponse[]>;
}

function resourceContextNotFound() {
  return new AuthError(404, "Resource context not found");
}

function toOwnerType(ownerType: ResourceContext["ownerType"]) {
  return ownerType === "user"
    ? ResourceOwnerType.USER
    : ResourceOwnerType.GROUP;
}

export function createResourceService(prisma: PrismaClient): ResourceService {
  return {
    async listResources(userId, context) {
      const organizationMembership =
        await prisma.organizationMembership.findUnique({
          where: {
            userId_organizationId: {
              userId,
              organizationId: context.organizationId,
            },
          },
          select: { userId: true },
        });

      if (!organizationMembership) {
        throw resourceContextNotFound();
      }

      if (context.ownerType === "user" && context.ownerId !== userId) {
        throw resourceContextNotFound();
      }

      if (context.ownerType === "group") {
        const group = await prisma.group.findFirst({
          where: {
            id: context.ownerId,
            organizationId: context.organizationId,
          },
          select: { id: true },
        });
        const groupMembership = group
          ? await prisma.groupMembership.findUnique({
              where: { groupId_userId: { groupId: group.id, userId } },
              select: { userId: true },
            })
          : null;

        if (!groupMembership) {
          throw resourceContextNotFound();
        }
      }

      const resources = await prisma.resourceReference.findMany({
        where: {
          organizationId: context.organizationId,
          ownerType: toOwnerType(context.ownerType),
          ownerId: context.ownerId,
        },
        orderBy: [{ label: "asc" }, { id: "asc" }],
      });

      return resources.map((resource) => ({
        id: resource.id,
        type: resource.type,
        label: resource.label,
        organizationId: resource.organizationId,
        ownerType:
          resource.ownerType === ResourceOwnerType.USER ? "user" : "group",
        ownerId: resource.ownerId,
        createdByUserId: resource.createdByUserId,
      }));
    },
  };
}
