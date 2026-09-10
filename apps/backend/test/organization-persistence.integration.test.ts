import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  OrganizationRole,
  PrismaClient,
} from "../src/generated/prisma/client.js";
import { createOrganizationPersistence } from "../src/organization-persistence.js";
import { requireTestDatabaseUrl } from "./test-database-url.js";

// Validate before creating a client or issuing any destructive cleanup.
const databaseUrl = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const persistence = createOrganizationPersistence(prisma);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.organizationMembership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
});

describe("APP-01 PostgreSQL persistence", () => {
  it("persists distinct local roles for one user across organizations", async () => {
    const user = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const firstOrganization = await persistence.createOrganization({
      name: "Diplomado IA 2027",
      slug: "Diplomado IA 2027",
    });
    const secondOrganization = await persistence.createOrganization({
      name: "Diplomado Datos 2027",
      slug: "Diplomado Datos 2027",
    });

    await persistence.createMembership({
      userId: user.id,
      organizationId: firstOrganization.id,
      role: OrganizationRole.ADMIN,
    });
    await persistence.createMembership({
      userId: user.id,
      organizationId: secondOrganization.id,
      role: OrganizationRole.STUDENT,
    });

    const memberships = await prisma.organizationMembership.findMany({
      where: { userId: user.id },
      orderBy: { organizationId: "asc" },
    });

    expect(user.rut).toBe("123456785");
    expect(memberships.map(({ role }) => role).sort()).toEqual([
      OrganizationRole.ADMIN,
      OrganizationRole.STUDENT,
    ]);
  });

  it("rejects duplicate RUTs and duplicate memberships", async () => {
    const user = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    const organization = await persistence.createOrganization({
      name: "Diplomado IA 2028",
      slug: "Diplomado IA 2028",
    });

    await persistence.createMembership({
      userId: user.id,
      organizationId: organization.id,
      role: OrganizationRole.STUDENT,
    });

    await expect(
      persistence.createUser({ name: "Ada Lovelace", rut: "123456793" }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      persistence.createMembership({
        userId: user.id,
        organizationId: organization.id,
        role: OrganizationRole.ADMIN,
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("persists optional profile and organization fields", async () => {
    const user = await persistence.createUser({
      name: "Linus Torvalds",
      rut: "12.345.670-K",
      email: "linus@example.test",
      username: "linus",
    });
    const organization = await persistence.createOrganization({
      name: "Diplomado Ágil",
      slug: "Diplomado Ágil",
      description: "Optional description",
      enabled: false,
    });

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { email: "linus.updated@example.test", username: "lt" },
    });

    expect(updatedUser).toMatchObject({
      email: "linus.updated@example.test",
      username: "lt",
    });
    expect(organization).toMatchObject({
      slug: "diplomado-agil",
      description: "Optional description",
      enabled: false,
    });
    expect(organization.createdAt).toBeInstanceOf(Date);
    expect(organization.updatedAt).toBeInstanceOf(Date);
  });
});
