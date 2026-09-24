import {
  OrganizationRole,
  ResourceOwnerType,
  type PrismaClient,
} from "./generated/prisma/client.js";
import { AuthError } from "./auth.js";
import type { ResourceContext } from "./resources.js";

export type BusinessPolicy = {
  version: string;
  manualReviewThreshold: number;
};

export interface BusinessPolicyService {
  listPolicies(
    userId: string,
    context: ResourceContext,
  ): Promise<BusinessPolicy[]>;
  createPolicy(
    userId: string,
    context: ResourceContext,
    input: BusinessPolicy,
  ): Promise<BusinessPolicy>;
  updatePolicy(
    userId: string,
    context: ResourceContext,
    version: string,
    input: Pick<BusinessPolicy, "manualReviewThreshold">,
  ): Promise<BusinessPolicy>;
}

function inaccessiblePolicy() {
  return new AuthError(404, "Business policy not found");
}

function policyOwnerType(ownerType: ResourceContext["ownerType"]) {
  return ownerType === "user"
    ? ResourceOwnerType.USER
    : ResourceOwnerType.GROUP;
}

async function authorizePolicyContext(
  prisma: PrismaClient,
  userId: string,
  context: ResourceContext,
  manages: boolean,
) {
  const membership = await prisma.organizationMembership.findUnique({
    where: {
      userId_organizationId: { userId, organizationId: context.organizationId },
    },
    select: { role: true },
  });
  if (
    !membership ||
    (context.ownerType === "user" && context.ownerId !== userId)
  ) {
    throw inaccessiblePolicy();
  }
  if (context.ownerType === "group") {
    if (manages && membership.role !== OrganizationRole.ADMIN) {
      throw inaccessiblePolicy();
    }
    if (!manages) {
      const groupMembership = await prisma.groupMembership.findFirst({
        where: {
          userId,
          groupId: context.ownerId,
          organizationId: context.organizationId,
        },
        select: { userId: true },
      });
      if (!groupMembership) throw inaccessiblePolicy();
    }
  }
}

function toBusinessPolicy(policy: {
  version: string;
  manualReviewThreshold: { toNumber(): number };
}): BusinessPolicy {
  return {
    version: policy.version,
    manualReviewThreshold: policy.manualReviewThreshold.toNumber(),
  };
}

export function createBusinessPolicyService(
  prisma: PrismaClient,
): BusinessPolicyService {
  return {
    async listPolicies(userId, context) {
      await authorizePolicyContext(prisma, userId, context, false);
      const policies = await prisma.businessPolicy.findMany({
        where: {
          organizationId: context.organizationId,
          ownerType: policyOwnerType(context.ownerType),
          ownerId: context.ownerId,
        },
        orderBy: { version: "asc" },
      });
      return policies.map(toBusinessPolicy);
    },
    async createPolicy(userId, context, input) {
      await authorizePolicyContext(prisma, userId, context, true);
      try {
        return toBusinessPolicy(
          await prisma.businessPolicy.create({
            data: {
              organizationId: context.organizationId,
              ownerType: policyOwnerType(context.ownerType),
              ownerId: context.ownerId,
              version: input.version,
              manualReviewThreshold: input.manualReviewThreshold,
            },
          }),
        );
      } catch (error) {
        if ((error as { code?: unknown }).code === "P2002") {
          throw new AuthError(409, "Business policy version already exists");
        }
        throw error;
      }
    },
    async updatePolicy(userId, context, version, input) {
      await authorizePolicyContext(prisma, userId, context, true);
      const updated = await prisma.businessPolicy.updateMany({
        where: {
          organizationId: context.organizationId,
          ownerType: policyOwnerType(context.ownerType),
          ownerId: context.ownerId,
          version,
        },
        data: { manualReviewThreshold: input.manualReviewThreshold },
      });
      if (updated.count !== 1) throw inaccessiblePolicy();
      return toBusinessPolicy(
        await prisma.businessPolicy.findFirstOrThrow({
          where: {
            organizationId: context.organizationId,
            ownerType: policyOwnerType(context.ownerType),
            ownerId: context.ownerId,
            version,
          },
        }),
      );
    },
  };
}
