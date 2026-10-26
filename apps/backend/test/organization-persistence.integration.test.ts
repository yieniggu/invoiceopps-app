import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  OrganizationRole,
  PrismaClient,
} from "../src/generated/prisma/client.js";
import { AuthError, createAuthService } from "../src/auth.js";
import { provisionInternalUser } from "../src/internal-user-provisioning.js";
import { createOrganizationPersistence } from "../src/organization-persistence.js";
import { createGroupService } from "../src/groups.js";
import { createInvoiceService } from "../src/invoices.js";
import { createBusinessPolicyService } from "../src/business-policies.js";
import { parsePlatformAdministratorCommand } from "../src/platform-administrator-command.js";
import { createPlatformAdministratorService } from "../src/platform-administrator.js";
import { requireTestDatabaseUrl } from "./test-database-url.js";

// Validate before creating a client or issuing any destructive cleanup.
const databaseUrl = requireTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const persistence = createOrganizationPersistence(prisma);

afterAll(async () => {
  try {
    await resetOwnedTestDatabase();
  } finally {
    await prisma.$disconnect();
  }
});

async function resetOwnedTestDatabase() {
  // TRUNCATE bypasses the append-only DELETE trigger only while resetting isolated test data.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "PlatformAdministrativeAuditEvent", "PlatformAdministrator"',
  );
  await prisma.session.deleteMany();
  await prisma.invoiceIdempotencyRecord.deleteMany();
  await prisma.apiToken.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.businessPolicy.deleteMany();
  await prisma.groupMembership.deleteMany();
  await prisma.group.deleteMany();
  await prisma.organizationMembership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
}

beforeEach(resetOwnedTestDatabase);

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
      role: OrganizationRole.USER,
    });

    const memberships = await prisma.organizationMembership.findMany({
      where: { userId: user.id },
      orderBy: { organizationId: "asc" },
    });

    expect(user.rut).toBe("123456785");
    expect(memberships.map(({ role }) => role).sort()).toEqual([
      OrganizationRole.ADMIN,
      OrganizationRole.USER,
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
      role: OrganizationRole.USER,
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
  it("provisions credentials only through an internal fixture", async () => {
    const rut = "12.345.678-5";
    const user = await provisionInternalUser(prisma, {
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

    expect(memberships).toHaveLength(0);
    expect(storedUser.passwordHash).toMatch(/^scrypt\$/);
    expect(storedUser.passwordHash).not.toContain(
      "correct-horse-battery-staple",
    );
    expect(user).not.toHaveProperty("passwordHash");
  });

  it("rejects duplicate internal fixture identities without memberships", async () => {
    const provision = {
      name: "Ada Lovelace",
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    };

    await provisionInternalUser(prisma, provision);
    await expect(
      provisionInternalUser(prisma, provision),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.organizationMembership.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it("rejects invalid credentials without revealing whether the user exists", async () => {
    const auth = createAuthService(prisma);
    await provisionInternalUser(prisma, {
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
    const auth = createAuthService(prisma);

    await expect(
      auth.login({
        rut: "12.345.678-5",
        password: "correct-horse-battery-staple",
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("persists only a hash for an opaque login session", async () => {
    const auth = createAuthService(prisma);
    await provisionInternalUser(prisma, {
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
    const auth = createAuthService(prisma);
    const user = await provisionInternalUser(prisma, {
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
          role: OrganizationRole.USER,
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
      rut: "12345678-5",
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
    const auth = createAuthService(prisma);
    await provisionInternalUser(prisma, {
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
      rut: "12345678-5",
    });
    expect(await prisma.session.count()).toBe(1);
  });
});

describe("APP-04 PostgreSQL organization groups", () => {
  it("isolates groups by organization, requires an ADMIN, and prevents invalid or duplicate members", async () => {
    const firstOrganization = await persistence.createOrganization({
      name: "AI Academy",
      slug: "ai-academy",
    });
    const secondOrganization = await persistence.createOrganization({
      name: "Data Academy",
      slug: "data-academy",
    });
    const admin = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const student = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    const outsider = await persistence.createUser({
      name: "Linus Torvalds",
      rut: "12.345.670-K",
    });
    await prisma.organizationMembership.createMany({
      data: [
        {
          userId: admin.id,
          organizationId: firstOrganization.id,
          role: OrganizationRole.ADMIN,
        },
        {
          userId: student.id,
          organizationId: firstOrganization.id,
          role: OrganizationRole.USER,
        },
        {
          userId: outsider.id,
          organizationId: secondOrganization.id,
          role: OrganizationRole.USER,
        },
      ],
    });
    const groups = createGroupService(prisma);

    const zeta = await groups.createGroup(admin.id, firstOrganization.id, {
      name: "Zeta group",
    });
    const alpha = await groups.createGroup(admin.id, firstOrganization.id, {
      name: "Alpha group",
    });
    const populated = await groups.addMember(
      admin.id,
      firstOrganization.id,
      alpha.id,
      student.id,
    );

    expect(populated.members).toEqual([
      { id: admin.id, name: "Ada Lovelace", rut: "12345678-5" },
      { id: student.id, name: "Grace Hopper", rut: "12345679-3" },
    ]);
    await expect(
      prisma.groupMembership.create({
        data: {
          groupId: alpha.id,
          userId: outsider.id,
          organizationId: firstOrganization.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      groups.addMember(admin.id, firstOrganization.id, alpha.id, outsider.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      groups.addMember(admin.id, firstOrganization.id, alpha.id, student.id),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      groups.createGroup(student.id, firstOrganization.id, { name: "Denied" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      groups.updateGroup(outsider.id, firstOrganization.id, alpha.id, {
        name: "Denied",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(groups.listGroups(student.id)).resolves.toEqual([
      expect.objectContaining({ id: alpha.id, name: "Alpha group" }),
    ]);
    await expect(groups.listGroups(admin.id)).resolves.toEqual([
      expect.objectContaining({ id: alpha.id, name: "Alpha group" }),
      expect.objectContaining({ id: zeta.id, name: "Zeta group" }),
    ]);
  });
});

describe("Organization group catalog PostgreSQL integration", () => {
  async function catalogFixture() {
    const organization = await persistence.createOrganization({
      name: "Catalog Academy",
      slug: "catalog-academy",
    });
    const foreign = await persistence.createOrganization({
      name: "Foreign Academy",
      slug: "foreign-academy",
    });
    const admin = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const student = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    await prisma.organizationMembership.createMany({
      data: [
        {
          userId: admin.id,
          organizationId: organization.id,
          role: OrganizationRole.ADMIN,
        },
        {
          userId: student.id,
          organizationId: organization.id,
          role: OrganizationRole.USER,
        },
      ],
    });
    const groups = createGroupService(prisma);
    const first = await groups.createGroup(admin.id, organization.id, {
      name: "Same name",
    });
    const second = await groups.createGroup(admin.id, organization.id, {
      name: "Same name",
    });
    await groups.removeMember(admin.id, organization.id, first.id, admin.id);
    return { organization, foreign, admin, student, groups, first, second };
  }
  it("catalogs groups after self removal without granting membership or exposing a roster", async () => {
    const { organization, admin, student, groups, first, second } =
      await catalogFixture();
    const page = await groups.listOrganizationGroups(
      admin.id,
      organization.id,
      { limit: 50 },
    );
    expect(page.groups.map((group) => group.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(page.nextCursor).toBeNull();
    expect(Object.keys(page.groups[0]).sort()).toEqual([
      "description",
      "id",
      "name",
      "organization",
    ]);
    expect(
      (await groups.listGroups(admin.id)).map((group) => group.id),
    ).toEqual([second.id]);
    await groups.updateGroup(admin.id, organization.id, first.id, {
      description: "Still administrable",
    });
    await groups.addMember(admin.id, organization.id, first.id, student.id);
    await groups.removeMember(admin.id, organization.id, first.id, student.id);
    await groups.deleteGroup(admin.id, organization.id, first.id);
    expect(
      (
        await groups.listOrganizationGroups(admin.id, organization.id, {
          limit: 50,
        })
      ).groups,
    ).toHaveLength(1);
  });
  it("enforces live ADMIN/platform singleton capability, organization existence and cross-organization cursor isolation", async () => {
    const { organization, foreign, admin, student, groups, first } =
      await catalogFixture();
    await expect(
      groups.listOrganizationGroups(student.id, organization.id, { limit: 50 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      groups.listOrganizationGroups(admin.id, foreign.id, { limit: 50 }),
    ).rejects.toMatchObject({ status: 404 });
    await createPlatformAdministratorService(prisma).bootstrap(student.id);
    expect(
      (
        await groups.listOrganizationGroups(student.id, organization.id, {
          limit: 50,
        })
      ).groups,
    ).toHaveLength(2);
    await expect(
      groups.listOrganizationGroups(student.id, admin.id, { limit: 50 }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      groups.listOrganizationGroups(student.id, foreign.id, {
        limit: 50,
        cursor: first.id,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await prisma.organizationMembership.update({
      where: {
        userId_organizationId: {
          userId: admin.id,
          organizationId: organization.id,
        },
      },
      data: { role: OrganizationRole.USER },
    });
    await expect(
      groups.listOrganizationGroups(admin.id, organization.id, { limit: 50 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      groups.updateGroup(admin.id, organization.id, first.id, {
        name: "Denied",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("paginates deterministically across duplicate names using organization-bound cursors and bounded limits", async () => {
    const { organization, admin, groups, first, second } =
      await catalogFixture();
    const page = await groups.listOrganizationGroups(
      admin.id,
      organization.id,
      { limit: 1 },
    );
    const next = await groups.listOrganizationGroups(
      admin.id,
      organization.id,
      { limit: 1, cursor: page.nextCursor! },
    );
    expect(page.groups).toHaveLength(1);
    expect(next.groups).toHaveLength(1);
    expect([...page.groups, ...next.groups].map((group) => group.id)).toEqual(
      [first.id, second.id].sort(),
    );
    expect(next.nextCursor).toBeNull();
    await expect(
      groups.listOrganizationGroups(admin.id, organization.id, { limit: 101 }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("PlatformAdministrator PostgreSQL integration", () => {
  it("allows only the global administrator to create organizations and provision a temporary credential transactionally", async () => {
    const global = await persistence.createUser({
      name: "Global",
      rut: "12.345.678-5",
    });
    const organizationAdmin = await persistence.createUser({
      name: "Organization",
      rut: "12.345.679-3",
    });
    const service = createPlatformAdministratorService(prisma);
    await service.bootstrap(global.id);
    await expect(
      service.createOrganization!(organizationAdmin.id, {
        name: "Denied",
        slug: "denied",
      }),
    ).rejects.toMatchObject({ status: 403 });
    const organization = await service.createOrganization!(global.id, {
      name: "Provisioned",
      slug: "provisioned",
    });
    await prisma.organizationMembership.create({
      data: {
        userId: organizationAdmin.id,
        organizationId: organization.id,
        role: OrganizationRole.ADMIN,
      },
    });
    await expect(
      service.provisionUser!(organizationAdmin.id, {
        name: "Denied",
        rut: "12.345.670-K",
        organizationId: organization.id,
        role: OrganizationRole.USER,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const provisioned = await service.provisionUser!(global.id, {
      name: "Student",
      rut: "12.345.670-K",
      organizationId: organization.id,
      role: OrganizationRole.USER,
    });
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: provisioned.user.userId },
    });
    const membership = await prisma.organizationMembership.findUniqueOrThrow({
      where: {
        userId_organizationId: {
          userId: stored.id,
          organizationId: organization.id,
        },
      },
    });
    const audit = await prisma.platformAdministrativeAuditEvent.findMany({
      where: { targetUserId: stored.id },
    });
    expect(provisioned.user.rut).toBe("12345670-K");
    expect(stored.rut).toBe("12345670K");
    expect(provisioned.temporaryPassword).toHaveLength(32);
    expect(stored.passwordHash).toMatch(/^scrypt\$/);
    expect(stored.passwordHash).not.toContain(provisioned.temporaryPassword);
    expect(stored.mustChangePassword).toBe(true);
    expect(stored.temporaryPasswordExpiresAt).toBeInstanceOf(Date);
    expect(membership.role).toBe(OrganizationRole.USER);
    expect(audit.map(({ type }) => type)).toContain("USER_PROVISIONED");
    expect(JSON.stringify(audit)).not.toContain(provisioned.temporaryPassword);
  });

  it("clears the temporary requirement, keeps the current session and revokes other sessions after password change", async () => {
    const global = await persistence.createUser({
      name: "Global",
      rut: "12.345.678-5",
    });
    const service = createPlatformAdministratorService(prisma);
    await service.bootstrap(global.id);
    const organization = await service.createOrganization!(global.id, {
      name: "Provisioned",
      slug: "provisioned",
    });
    const provisioned = await service.provisionUser!(global.id, {
      name: "Student",
      rut: "12.345.679-3",
      organizationId: organization.id,
      role: OrganizationRole.USER,
    });
    const auth = createAuthService(prisma);
    const first = await auth.login({
      rut: "12.345.679-3",
      password: provisioned.temporaryPassword,
    });
    const second = await auth.login({
      rut: "12.345.679-3",
      password: provisioned.temporaryPassword,
    });
    expect((await auth.getProfile(first.sessionToken)).mustChangePassword).toBe(
      true,
    );
    await auth.changePassword!(first.sessionToken, {
      currentPassword: provisioned.temporaryPassword,
      newPassword: "changed-password-123",
    });
    expect(await auth.getProfile(first.sessionToken)).toMatchObject({
      mustChangePassword: false,
    });
    await expect(auth.getProfile(second.sessionToken)).rejects.toMatchObject({
      status: 401,
    });
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: provisioned.user.userId },
    });
    expect(stored.temporaryPasswordExpiresAt).toBeNull();
    expect(stored.mustChangePassword).toBe(false);
    expect(
      await prisma.platformAdministrativeAuditEvent.count({
        where: { targetUserId: stored.id, type: "PASSWORD_CHANGED" },
      }),
    ).toBe(1);
  });

  it("discovers every organization and group without local membership only for the platform administrator", async () => {
    const platformUser = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const organizationAdministrator = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    const unauthorizedUser = await persistence.createUser({
      name: "Linus Torvalds",
      rut: "12.345.670-K",
    });
    const organization = await persistence.createOrganization({
      name: "AI Academy",
      slug: "ai-academy",
    });
    await prisma.organizationMembership.create({
      data: {
        userId: organizationAdministrator.id,
        organizationId: organization.id,
        role: OrganizationRole.ADMIN,
      },
    });
    const groups = createGroupService(prisma);
    const platformAdministrators = createPlatformAdministratorService(prisma);
    await platformAdministrators.bootstrap(platformUser.id);
    const group = await groups.createGroup(platformUser.id, organization.id, {
      name: "Advanced topics",
    });

    await expect(
      platformAdministrators.listOrganizations(unauthorizedUser.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      platformAdministrators.listOrganizations(platformUser.id),
    ).resolves.toEqual([
      {
        id: organization.id,
        name: "AI Academy",
        groups: [
          {
            id: group.id,
            name: "Advanced topics",
            description: null,
            organization: { id: organization.id, name: "AI Academy" },
            members: [],
          },
        ],
      },
    ]);
  });

  it("enforces singleton bootstrap and records immutable audit events", async () => {
    const firstUser = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const secondUser = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    const platformAdministrators = createPlatformAdministratorService(prisma);

    await platformAdministrators.bootstrap(firstUser.id);

    await expect(
      platformAdministrators.bootstrap(secondUser.id),
    ).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      prisma.platformAdministrator.create({
        data: { id: 2, userId: secondUser.id },
      }),
    ).rejects.toThrow();
    expect(await prisma.platformAdministrator.count()).toBe(1);

    const auditEvent =
      await prisma.platformAdministrativeAuditEvent.findFirstOrThrow();
    await expect(
      prisma.platformAdministrativeAuditEvent.update({
        where: { id: auditEvent.id },
        data: { role: OrganizationRole.ADMIN },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.platformAdministrativeAuditEvent.delete({
        where: { id: auditEvent.id },
      }),
    ).rejects.toThrow(/append-only/);
  });

  it("creates, promotes, demotes, and removes memberships with exact append-only audits", async () => {
    const platformUser = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const firstAdministrator = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    const secondAdministrator = await persistence.createUser({
      name: "Linus Torvalds",
      rut: "12.345.670-K",
    });
    const member = await persistence.createUser({
      name: "Margaret Hamilton",
      rut: "12.345.671-8",
    });
    const organization = await persistence.createOrganization({
      name: "AI Academy",
      slug: "ai-academy",
    });
    await prisma.organizationMembership.createMany({
      data: [firstAdministrator, secondAdministrator].map((user) => ({
        userId: user.id,
        organizationId: organization.id,
        role: OrganizationRole.ADMIN,
      })),
    });
    const platformAdministrators = createPlatformAdministratorService(prisma);
    await platformAdministrators.bootstrap(platformUser.id);

    await platformAdministrators.createMembership(
      platformUser.id,
      organization.id,
      member.id,
      OrganizationRole.USER,
    );
    await platformAdministrators.changeMembershipRole(
      platformUser.id,
      organization.id,
      member.id,
      OrganizationRole.ADMIN,
    );
    await platformAdministrators.changeMembershipRole(
      platformUser.id,
      organization.id,
      member.id,
      OrganizationRole.USER,
    );
    await platformAdministrators.removeMembership(
      platformUser.id,
      organization.id,
      member.id,
    );

    expect(
      await prisma.organizationMembership.findMany({
        where: { organizationId: organization.id },
        select: { userId: true, role: true },
        orderBy: { userId: "asc" },
      }),
    ).toEqual(
      [firstAdministrator, secondAdministrator]
        .map(({ id }) => ({ userId: id, role: OrganizationRole.ADMIN }))
        .sort((left, right) => left.userId.localeCompare(right.userId)),
    );
    const auditEvents = await prisma.platformAdministrativeAuditEvent.findMany({
      where: { organizationId: organization.id },
      select: {
        type: true,
        actorUserId: true,
        targetUserId: true,
        organizationId: true,
        previousRole: true,
        role: true,
      },
    });
    expect(auditEvents).toHaveLength(4);
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        {
          type: "ORGANIZATION_MEMBERSHIP_CREATED",
          actorUserId: platformUser.id,
          targetUserId: member.id,
          organizationId: organization.id,
          previousRole: null,
          role: OrganizationRole.USER,
        },
        {
          type: "ORGANIZATION_MEMBERSHIP_ROLE_CHANGED",
          actorUserId: platformUser.id,
          targetUserId: member.id,
          organizationId: organization.id,
          previousRole: OrganizationRole.USER,
          role: OrganizationRole.ADMIN,
        },
        {
          type: "ORGANIZATION_MEMBERSHIP_ROLE_CHANGED",
          actorUserId: platformUser.id,
          targetUserId: member.id,
          organizationId: organization.id,
          previousRole: OrganizationRole.ADMIN,
          role: OrganizationRole.USER,
        },
        {
          type: "ORGANIZATION_MEMBERSHIP_REMOVED",
          actorUserId: platformUser.id,
          targetUserId: member.id,
          organizationId: organization.id,
          previousRole: OrganizationRole.USER,
          role: null,
        },
      ]),
    );
  });

  it("rolls back membership creation when the audit insert fails", async () => {
    const platformUser = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const member = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    const organization = await persistence.createOrganization({
      name: "AI Academy",
      slug: "ai-academy",
    });
    const platformAdministrators = createPlatformAdministratorService(prisma);
    await platformAdministrators.bootstrap(platformUser.id);

    try {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION fail_platform_membership_audit_insert() RETURNS trigger AS $$
        BEGIN
          IF NEW."organizationId" = '${organization.id}' THEN
            RAISE EXCEPTION 'induced audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER fail_platform_membership_audit_insert
        BEFORE INSERT ON "PlatformAdministrativeAuditEvent"
        FOR EACH ROW EXECUTE FUNCTION fail_platform_membership_audit_insert();
      `);
      await expect(
        platformAdministrators.createMembership(
          platformUser.id,
          organization.id,
          member.id,
          OrganizationRole.USER,
        ),
      ).rejects.toThrow(/induced audit failure/);
      expect(
        await prisma.organizationMembership.findUnique({
          where: {
            userId_organizationId: {
              userId: member.id,
              organizationId: organization.id,
            },
          },
        }),
      ).toBeNull();
      expect(
        await prisma.platformAdministrativeAuditEvent.count({
          where: { organizationId: organization.id },
        }),
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS fail_platform_membership_audit_insert ON "PlatformAdministrativeAuditEvent"; DROP FUNCTION IF EXISTS fail_platform_membership_audit_insert();',
      );
    }
  });

  it("mutates only when a confirmed parsed command is applied", async () => {
    const firstUser = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const secondUser = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    const platformAdministrators = createPlatformAdministratorService(prisma);

    for (const arguments_ of [
      [],
      ["bootstrap", firstUser.id],
      ["bootstrap", firstUser.id, "--confirm-transfer"],
      ["transfer", secondUser.id, "--confirm-bootstrap"],
    ]) {
      expect(() => parsePlatformAdministratorCommand(arguments_)).toThrow();
    }
    expect(await prisma.platformAdministrator.count()).toBe(0);
    expect(await prisma.platformAdministrativeAuditEvent.count()).toBe(0);

    const bootstrap = parsePlatformAdministratorCommand([
      "bootstrap",
      firstUser.id,
      "--confirm-bootstrap",
    ]);
    await platformAdministrators.bootstrap(bootstrap.userId);
    const transfer = parsePlatformAdministratorCommand([
      "transfer",
      secondUser.id,
      "--confirm-transfer",
    ]);
    await platformAdministrators.transfer(transfer.userId);

    await expect(
      prisma.platformAdministrator.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({ userId: secondUser.id });
    const auditEvents = await prisma.platformAdministrativeAuditEvent.findMany({
      select: { type: true, actorUserId: true, targetUserId: true },
    });
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents).toEqual(
      expect.arrayContaining([
        {
          type: "PLATFORM_ADMINISTRATOR_BOOTSTRAPPED",
          actorUserId: firstUser.id,
          targetUserId: firstUser.id,
        },
        {
          type: "PLATFORM_ADMINISTRATOR_TRANSFERRED",
          actorUserId: firstUser.id,
          targetUserId: secondUser.id,
        },
      ]),
    );
  });

  it("rejects organization membership administration by a non-platform user", async () => {
    const platformUser = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const unauthorizedUser = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    const member = await persistence.createUser({
      name: "Linus Torvalds",
      rut: "12.345.670-K",
    });
    const organization = await persistence.createOrganization({
      name: "AI Academy",
      slug: "ai-academy",
    });
    await prisma.organizationMembership.create({
      data: {
        userId: member.id,
        organizationId: organization.id,
        role: OrganizationRole.USER,
      },
    });
    const platformAdministrators = createPlatformAdministratorService(prisma);
    await platformAdministrators.bootstrap(platformUser.id);

    await expect(
      platformAdministrators.createMembership(
        unauthorizedUser.id,
        organization.id,
        unauthorizedUser.id,
        OrganizationRole.USER,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      platformAdministrators.changeMembershipRole(
        unauthorizedUser.id,
        organization.id,
        member.id,
        OrganizationRole.ADMIN,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      platformAdministrators.removeMembership(
        unauthorizedUser.id,
        organization.id,
        member.id,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await prisma.organizationMembership.count()).toBe(1);
  });

  it("retains an organization ADMIN during parallel demotion and removal attempts", async () => {
    const platformUser = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const firstAdministrator = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    const secondAdministrator = await persistence.createUser({
      name: "Linus Torvalds",
      rut: "12.345.670-K",
    });
    const organization = await persistence.createOrganization({
      name: "AI Academy",
      slug: "ai-academy",
    });
    await prisma.organizationMembership.createMany({
      data: [firstAdministrator, secondAdministrator].map((user) => ({
        userId: user.id,
        organizationId: organization.id,
        role: OrganizationRole.ADMIN,
      })),
    });
    const platformAdministrators = createPlatformAdministratorService(prisma);
    await platformAdministrators.bootstrap(platformUser.id);

    const demotions = await Promise.allSettled([
      platformAdministrators.changeMembershipRole(
        platformUser.id,
        organization.id,
        firstAdministrator.id,
        OrganizationRole.USER,
      ),
      platformAdministrators.changeMembershipRole(
        platformUser.id,
        organization.id,
        secondAdministrator.id,
        OrganizationRole.USER,
      ),
    ]);
    expect(demotions.some((result) => result.status === "fulfilled")).toBe(
      true,
    );
    expect(
      await prisma.organizationMembership.count({
        where: {
          organizationId: organization.id,
          role: OrganizationRole.ADMIN,
        },
      }),
    ).toBeGreaterThanOrEqual(1);

    await prisma.organizationMembership.updateMany({
      where: { organizationId: organization.id },
      data: { role: OrganizationRole.ADMIN },
    });
    const removals = await Promise.allSettled([
      platformAdministrators.removeMembership(
        platformUser.id,
        organization.id,
        firstAdministrator.id,
      ),
      platformAdministrators.removeMembership(
        platformUser.id,
        organization.id,
        secondAdministrator.id,
      ),
    ]);
    expect(removals.some((result) => result.status === "fulfilled")).toBe(true);
    expect(
      await prisma.organizationMembership.count({
        where: {
          organizationId: organization.id,
          role: OrganizationRole.ADMIN,
        },
      }),
    ).toBeGreaterThanOrEqual(1);
  });
});

function invoiceFixture(
  organizationId: string,
  groupId: string,
  createdByUserId: string,
  businessId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    businessId,
    organizationId,
    groupId,
    supplierName: "Proveedor local",
    amountPesos: 12500,
    currency: "CLP" as const,
    issuedOn: new Date("2026-10-25T00:00:00.000Z"),
    dueOn: new Date("2026-11-25T00:00:00.000Z"),
    businessStatus: "PENDING" as const,
    createdByUserId,
    ...extra,
  };
}

describe("APP-06 PostgreSQL invoice domain", () => {
  it("reads group invoices, hides deleted ones and denies foreign contexts", async () => {
    const organization = await persistence.createOrganization({
      name: "AI Academy",
      slug: "ai-academy",
    });
    const actor = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const otherUser = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    await prisma.organizationMembership.createMany({
      data: [
        {
          userId: actor.id,
          organizationId: organization.id,
          role: OrganizationRole.USER,
        },
        {
          userId: otherUser.id,
          organizationId: organization.id,
          role: OrganizationRole.USER,
        },
      ],
    });
    const group = await prisma.group.create({
      data: { organizationId: organization.id, name: "Facturas" },
    });
    const otherGroup = await prisma.group.create({
      data: { organizationId: organization.id, name: "Otro" },
    });
    await prisma.groupMembership.createMany({
      data: [
        {
          groupId: group.id,
          userId: actor.id,
          organizationId: organization.id,
        },
        {
          groupId: otherGroup.id,
          userId: otherUser.id,
          organizationId: organization.id,
        },
      ],
    });
    const visible = await prisma.invoice.create({
      data: invoiceFixture(organization.id, group.id, actor.id, "FAC-001", {
        supplierName: "Acme Ltd.",
      }),
    });
    const foreign = await prisma.invoice.create({
      data: invoiceFixture(
        organization.id,
        otherGroup.id,
        otherUser.id,
        "FAC-002",
      ),
    });
    await prisma.invoice.create({
      data: invoiceFixture(organization.id, group.id, actor.id, "FAC-003", {
        deletedAt: new Date(),
        deletedByUserId: actor.id,
      }),
    });
    const invoices = createInvoiceService(prisma);
    const context = {
      organizationId: organization.id,
      ownerType: "group" as const,
      ownerId: group.id,
    };

    await expect(
      invoices.listInvoices(actor.id, context, { q: "", limit: 50 }),
    ).resolves.toMatchObject({
      invoices: [
        {
          id: visible.id,
          businessId: "FAC-001",
          amountPesos: 12500,
          issuedOn: "2026-10-25",
          dueOn: "2026-11-25",
          businessStatus: "PENDING",
          processingStatus: "NOT_REQUESTED",
        },
      ],
      nextCursor: null,
    });
    await expect(
      invoices.listInvoices(actor.id, context, { q: "acme", limit: 50 }),
    ).resolves.toMatchObject({ invoices: [{ businessId: "FAC-001" }] });
    const detail = await invoices.getInvoice(actor.id, context, visible.id);
    expect(detail).toMatchObject({ invoice: { id: visible.id } });
    expect(Object.keys(detail.invoice).sort()).toEqual([
      "amountPesos",
      "businessId",
      "businessStatus",
      "createdAt",
      "createdByUserId",
      "currency",
      "dueOn",
      "groupId",
      "id",
      "issuedOn",
      "organizationId",
      "processingStatus",
      "supplierName",
    ]);
    await expect(
      invoices.getInvoice(actor.id, context, foreign.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      invoices.listInvoices(
        actor.id,
        { ...context, ownerId: otherGroup.id },
        { q: "", limit: 50 },
      ),
    ).rejects.toMatchObject({ status: 404 });
    // P0 has no personal invoices.
    const personal = {
      organizationId: organization.id,
      ownerType: "user" as const,
      ownerId: actor.id,
    };
    await expect(
      invoices.listInvoices(actor.id, personal, { q: "", limit: 50 }),
    ).resolves.toEqual({ invoices: [], nextCursor: null });
    await expect(
      invoices.getInvoice(actor.id, personal, visible.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("isolates personal and group policy administration while allowing authorized policy reads", async () => {
    const organization = await persistence.createOrganization({
      name: "Policy authorization academy",
      slug: "policy-authorization-academy",
    });
    const otherOrganization = await persistence.createOrganization({
      name: "Other policy academy",
      slug: "other-policy-academy",
    });
    const owner = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const otherOwner = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    const groupStudent = await persistence.createUser({
      name: "Linus Torvalds",
      rut: "12.345.670-K",
    });
    await prisma.organizationMembership.createMany({
      data: [
        {
          userId: owner.id,
          organizationId: organization.id,
          role: OrganizationRole.ADMIN,
        },
        {
          userId: otherOwner.id,
          organizationId: organization.id,
          role: OrganizationRole.USER,
        },
        {
          userId: groupStudent.id,
          organizationId: organization.id,
          role: OrganizationRole.USER,
        },
      ],
    });
    const group = await prisma.group.create({
      data: { organizationId: organization.id, name: "Policy group" },
    });
    await prisma.groupMembership.createMany({
      data: [
        {
          groupId: group.id,
          userId: owner.id,
          organizationId: organization.id,
        },
        {
          groupId: group.id,
          userId: groupStudent.id,
          organizationId: organization.id,
        },
      ],
    });
    const policies = createBusinessPolicyService(prisma);
    const personalContext = {
      organizationId: organization.id,
      ownerType: "user" as const,
      ownerId: owner.id,
    };
    const groupContext = {
      organizationId: organization.id,
      ownerType: "group" as const,
      ownerId: group.id,
    };

    await expect(
      policies.createPolicy(owner.id, personalContext, {
        version: "personal-v1",
        manualReviewThreshold: 0,
      }),
    ).resolves.toEqual({ version: "personal-v1", manualReviewThreshold: 0 });
    await expect(
      policies.updatePolicy(owner.id, personalContext, "personal-v1", {
        manualReviewThreshold: 1,
      }),
    ).resolves.toEqual({ version: "personal-v1", manualReviewThreshold: 1 });
    await expect(
      policies.listPolicies(owner.id, personalContext),
    ).resolves.toEqual([{ version: "personal-v1", manualReviewThreshold: 1 }]);
    await expect(
      policies.listPolicies(otherOwner.id, personalContext),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      policies.createPolicy(otherOwner.id, personalContext, {
        version: "other-v1",
        manualReviewThreshold: 0.5,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      policies.updatePolicy(otherOwner.id, personalContext, "personal-v1", {
        manualReviewThreshold: 0.5,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      policies.listPolicies(owner.id, {
        ...personalContext,
        organizationId: otherOrganization.id,
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      policies.createPolicy(owner.id, groupContext, {
        version: "group-v1",
        manualReviewThreshold: 0.8,
      }),
    ).resolves.toEqual({ version: "group-v1", manualReviewThreshold: 0.8 });
    await expect(
      policies.updatePolicy(owner.id, groupContext, "group-v1", {
        manualReviewThreshold: 1,
      }),
    ).resolves.toEqual({ version: "group-v1", manualReviewThreshold: 1 });
    await expect(
      policies.listPolicies(groupStudent.id, groupContext),
    ).resolves.toEqual([{ version: "group-v1", manualReviewThreshold: 1 }]);
    await expect(
      policies.createPolicy(groupStudent.id, groupContext, {
        version: "student-v1",
        manualReviewThreshold: 0.8,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      policies.updatePolicy(groupStudent.id, groupContext, "group-v1", {
        manualReviewThreshold: 0.8,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      policies.listPolicies(otherOwner.id, groupContext),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("authorizes group members and traverses stable cursor pages", async () => {
    const organization = await persistence.createOrganization({
      name: "Cursor Academy",
      slug: "cursor-academy",
    });
    const member = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const nonMember = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    await prisma.organizationMembership.createMany({
      data: [
        {
          userId: member.id,
          organizationId: organization.id,
          role: OrganizationRole.USER,
        },
        {
          userId: nonMember.id,
          organizationId: organization.id,
          role: OrganizationRole.USER,
        },
      ],
    });
    const group = await prisma.group.create({
      data: { organizationId: organization.id, name: "Invoice group" },
    });
    await prisma.groupMembership.create({
      data: {
        groupId: group.id,
        userId: member.id,
        organizationId: organization.id,
      },
    });
    await prisma.invoice.createMany({
      data: [1, 2, 3].map((number) =>
        invoiceFixture(
          organization.id,
          group.id,
          member.id,
          `FAC-CURSOR-${number}`,
          { createdAt: new Date(`2026-09-21T00:00:0${number}.000Z`) },
        ),
      ),
    });
    const invoices = createInvoiceService(prisma);
    const groupContext = {
      organizationId: organization.id,
      ownerType: "group" as const,
      ownerId: group.id,
    };

    await expect(
      invoices.listInvoices(nonMember.id, groupContext, { q: "", limit: 50 }),
    ).rejects.toMatchObject({ status: 404 });

    const firstPage = await invoices.listInvoices(member.id, groupContext, {
      q: "",
      limit: 1,
    });
    const secondPage = await invoices.listInvoices(member.id, groupContext, {
      q: "",
      cursor: firstPage.nextCursor ?? undefined,
      limit: 1,
    });
    const thirdPage = await invoices.listInvoices(member.id, groupContext, {
      q: "",
      cursor: secondPage.nextCursor ?? undefined,
      limit: 1,
    });

    expect(firstPage).toMatchObject({
      invoices: [{ businessId: "FAC-CURSOR-3" }],
    });
    expect(secondPage).toMatchObject({
      invoices: [{ businessId: "FAC-CURSOR-2" }],
    });
    expect(thirdPage).toMatchObject({
      invoices: [{ businessId: "FAC-CURSOR-1" }],
      nextCursor: null,
    });
  });
});
