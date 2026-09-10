import {
  OrganizationRole,
  type PrismaClient,
} from "./generated/prisma/client.js";
import { normalizeRut, normalizeSlug } from "./identity.js";

export function createOrganizationPersistence(prisma: PrismaClient) {
  return {
    createUser(input: {
      name: string;
      rut: string;
      email?: string;
      username?: string;
    }) {
      return prisma.user.create({
        data: {
          name: input.name,
          rut: normalizeRut(input.rut),
          email: input.email,
          username: input.username,
        },
      });
    },
    createOrganization(input: {
      name: string;
      slug: string;
      description?: string;
      enabled?: boolean;
    }) {
      return prisma.organization.create({
        data: {
          name: input.name,
          slug: normalizeSlug(input.slug),
          description: input.description,
          enabled: input.enabled,
        },
      });
    },
    createMembership(input: {
      userId: string;
      organizationId: string;
      role: OrganizationRole;
    }) {
      return prisma.organizationMembership.create({ data: input });
    },
  };
}
