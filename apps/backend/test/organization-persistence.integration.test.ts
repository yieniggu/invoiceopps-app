import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  OrganizationRole,
  PrismaClient,
} from "../src/generated/prisma/client.js";
import { AuthError, createAuthService } from "../src/auth.js";
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
  await prisma.session.deleteMany();
  await prisma.organizationMembership.deleteMany();
  await prisma.authorizedUserOrganization.deleteMany();
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

describe("APP-02 PostgreSQL authentication persistence", () => {
  it("creates STUDENT memberships for every allowlisted organization and stores only a password hash", async () => {
    const firstOrganization = await persistence.createOrganization({
      name: "Diplomado IA 2029",
      slug: "diplomado-ia-2029",
    });
    const secondOrganization = await persistence.createOrganization({
      name: "Diplomado Datos 2029",
      slug: "diplomado-datos-2029",
    });
    const rut = "12.345.678-5";
    await prisma.authorizedUserOrganization.createMany({
      data: [
        { rut: "123456785", organizationId: firstOrganization.id },
        { rut: "123456785", organizationId: secondOrganization.id },
      ],
    });

    const auth = createAuthService(prisma, "allowlist");
    const user = await auth.signUp({
      name: "Ada Lovelace",
      rut,
      password: "correct-horse-battery-staple",
    });
    const storedUser = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const memberships = await prisma.organizationMembership.findMany({
      where: { userId: user.id },
      orderBy: { organizationId: "asc" },
    });

    expect(memberships).toHaveLength(2);
    expect(
      memberships.every(({ role }) => role === OrganizationRole.STUDENT),
    ).toBe(true);
    expect(storedUser.passwordHash).toMatch(/^scrypt\$/);
    expect(storedUser.passwordHash).not.toContain(
      "correct-horse-battery-staple",
    );
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("rejects non-allowlisted RUTs and leaves no records", async () => {
    const auth = createAuthService(prisma, "allowlist");

    await expect(
      auth.signUp({
        name: "Grace Hopper",
        rut: "12.345.679-3",
        password: "correct-horse-battery-staple",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.organizationMembership.count()).toBe(0);
  });

  it("does not leave partial records when the signup transaction fails", async () => {
    const organization = await persistence.createOrganization({
      name: "Diplomado IA 2030",
      slug: "diplomado-ia-2030",
    });
    await prisma.authorizedUserOrganization.create({
      data: { rut: "123456785", organizationId: organization.id },
    });
    const auth = createAuthService(prisma, "allowlist");
    const signup = {
      name: "Ada Lovelace",
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    };

    await auth.signUp(signup);
    await expect(auth.signUp(signup)).rejects.toMatchObject({ status: 409 });

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.organizationMembership.count()).toBe(1);
    expect(await prisma.session.count()).toBe(0);
  });

  it("rejects invalid credentials without revealing whether the user exists", async () => {
    const auth = createAuthService(prisma, "open");
    await auth.signUp({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    });

    const invalidPassword = auth.login({
      rut: "12.345.678-5",
      password: "not-the-correct-password",
    });
    const unknownUser = auth.login({
      rut: "12.345.679-3",
      password: "correct-horse-battery-staple",
    });

    await Promise.all([
      expect(invalidPassword).rejects.toEqual(
        new AuthError(401, "Invalid credentials"),
      ),
      expect(unknownUser).rejects.toEqual(
        new AuthError(401, "Invalid credentials"),
      ),
    ]);
  });

  it("does not authenticate APP-01 users without a password hash", async () => {
    await persistence.createUser({
      name: "Existing User",
      rut: "12.345.678-5",
    });
    const auth = createAuthService(prisma, "open");

    await expect(
      auth.login({
        rut: "12.345.678-5",
        password: "correct-horse-battery-staple",
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("persists only a hash for an opaque login session", async () => {
    const auth = createAuthService(prisma, "open");
    await auth.signUp({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    });

    const login = await auth.login({
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    });
    const session = await prisma.session.findFirstOrThrow({
      where: { userId: login.user.id },
    });

    expect(session.tokenHash).not.toBe(login.sessionToken);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("APP-03 PostgreSQL profile persistence", () => {
  it("resolves ordered memberships, updates only contact fields, and rejects expired or revoked sessions", async () => {
    const firstOrganization = await persistence.createOrganization({
      name: "Zeta Academy",
      slug: "zeta-academy",
    });
    const secondOrganization = await persistence.createOrganization({
      name: "Alpha Academy",
      slug: "alpha-academy",
    });
    const auth = createAuthService(prisma, "open");
    const user = await auth.signUp({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    });
    await prisma.organizationMembership.createMany({
      data: [
        {
          userId: user.id,
          organizationId: firstOrganization.id,
          role: OrganizationRole.ADMIN,
        },
        {
          userId: user.id,
          organizationId: secondOrganization.id,
          role: OrganizationRole.STUDENT,
        },
      ],
    });

    const login = await auth.login({
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    });
    const profile = await auth.getProfile(login.sessionToken);
    const updated = await auth.updateProfile(login.sessionToken, {
      email: "ada@example.test",
      username: "ada",
    });

    expect(
      profile.memberships.map(({ organization }) => organization.slug),
    ).toEqual(["alpha-academy", "zeta-academy"]);
    expect(updated).toMatchObject({
      name: "Ada Lovelace",
      rut: "123456785",
      email: "ada@example.test",
      username: "ada",
    });

    const session = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
    });
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(0) },
    });
    await expect(auth.getProfile(login.sessionToken)).rejects.toMatchObject({
      status: 401,
    });

    await prisma.session.delete({ where: { id: session.id } });
    await expect(auth.getProfile(login.sessionToken)).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("APP-02.1 PostgreSQL session lifecycle", () => {
  it("revokes only the current non-expired opaque session", async () => {
    const auth = createAuthService(prisma, "open");
    await auth.signUp({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    });

    const firstLogin = await auth.login({
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    });
    const secondLogin = await auth.login({
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    });

    await auth.logout(firstLogin.sessionToken);

    await expect(
      auth.getProfile(firstLogin.sessionToken),
    ).rejects.toMatchObject({
      status: 401,
    });
    await expect(auth.logout(firstLogin.sessionToken)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      auth.getProfile(secondLogin.sessionToken),
    ).resolves.toMatchObject({
      name: "Ada Lovelace",
      rut: "123456785",
    });
    expect(await prisma.session.count()).toBe(1);
  });
});
