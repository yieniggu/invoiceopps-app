import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  OrganizationRole,
  PrismaClient,
} from "../src/generated/prisma/client.js";
import { AuthError, createAuthService, hashPassword } from "../src/auth.js";
import {
  BootstrapRejectedError,
  createBootstrapService,
} from "../src/features/auth/bootstrap-service.js";
import { provisionInternalUser } from "../src/internal-user-provisioning.js";
import { createOrganizationPersistence } from "../src/organization-persistence.js";
import {
  createGroupCatalogService,
  createGroupService,
} from "../src/features/groups/services.js";
import { createOrganizationService } from "../src/features/orgs/services.js";
import { createUserService } from "../src/features/users/services.js";
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

// The first platform administrator is designated through the bootstrap
// service (the same code `pnpm recovery:bootstrap` runs). It only designates
// users with a usable credential, so the fixture user gets one first.
async function designatePlatformAdministrator(user: {
  id: string;
  rut: string;
}) {
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword("integration-password-1") },
  });
  return createBootstrapService(prisma).designateExisting(user.rut);
}

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

const NO_FLAGS = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};

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
    const catalog = createGroupCatalogService(prisma);

    const zeta = await groups.createGroup(admin.id, firstOrganization.id, {
      name: "Zeta group",
    });
    const alpha = await groups.createGroup(admin.id, firstOrganization.id, {
      name: "Alpha group",
    });
    expect(alpha).toEqual({
      id: alpha.id,
      organizationId: firstOrganization.id,
      name: "Alpha group",
      description: null,
    });
    const membership = await groups.addMember(
      admin.id,
      firstOrganization.id,
      alpha.id,
      student.id,
    );

    expect(membership).toEqual({
      userId: student.id,
      groupId: alpha.id,
      organizationId: firstOrganization.id,
      permissions: NO_FLAGS,
    });
    expect(
      (
        await groups.listMemberships(admin.id, firstOrganization.id, alpha.id)
      ).map(({ user }) => user),
    ).toEqual([{ id: student.id, name: "Grace Hopper", rut: student.rut }]);
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
    ).rejects.toMatchObject({
      status: 409,
      code: "ORGANIZATION_MEMBERSHIP_REQUIRED",
    });
    await expect(
      groups.addMember(admin.id, firstOrganization.id, alpha.id, student.id),
    ).rejects.toMatchObject({ status: 409, code: "MEMBERSHIP_CONFLICT" });
    await expect(
      groups.createGroup(student.id, firstOrganization.id, { name: "Denied" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      groups.updateMemberPermissions(
        outsider.id,
        firstOrganization.id,
        alpha.id,
        student.id,
        NO_FLAGS,
      ),
    ).rejects.toMatchObject({ status: 404 });
    // The creator is not a member, so only the student sees the group in the
    // membership-based catalog.
    await expect(catalog.listGroups(student.id)).resolves.toEqual([
      expect.objectContaining({ id: alpha.id, name: "Alpha group" }),
    ]);
    await expect(catalog.listGroups(admin.id)).resolves.toEqual([]);
    await expect(
      groups.listGroups(admin.id, firstOrganization.id),
    ).resolves.toEqual([
      expect.objectContaining({ id: alpha.id }),
      expect.objectContaining({ id: zeta.id }),
    ]);
  });
});

describe("Organization group listing PostgreSQL integration", () => {
  async function listingFixture() {
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
    await groups.addMember(admin.id, organization.id, first.id, student.id);
    return { organization, foreign, admin, student, groups, first, second };
  }

  it("lists every group for an ADMIN and only own groups for a USER, ordered deterministically", async () => {
    const { organization, admin, student, groups, first, second } =
      await listingFixture();

    expect(
      (await groups.listGroups(admin.id, organization.id)).map(
        (group) => group.id,
      ),
    ).toEqual([first.id, second.id].sort());
    expect(
      (await groups.listGroups(student.id, organization.id)).map(
        (group) => group.id,
      ),
    ).toEqual([first.id]);
  });

  it("enforces live ADMIN capability, organization membership and cross-organization isolation", async () => {
    const { organization, foreign, admin, student, groups, first } =
      await listingFixture();
    await expect(
      groups.listMemberships(student.id, organization.id, first.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(groups.listGroups(admin.id, foreign.id)).rejects.toMatchObject(
      { status: 404 },
    );
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
      groups.updateMemberPermissions(
        admin.id,
        organization.id,
        first.id,
        student.id,
        NO_FLAGS,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      groups.listMemberships(admin.id, organization.id, first.id),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("gives the platform administrator administrative access to groups without membership", async () => {
    const { organization, student, groups, first, second } =
      await listingFixture();
    const platformUser = await persistence.createUser({
      name: "Linus Torvalds",
      rut: "12.345.670-K",
    });
    await designatePlatformAdministrator(platformUser);

    await expect(
      groups
        .listGroups(platformUser.id, organization.id)
        .then((all) => all.map((group) => group.id)),
    ).resolves.toEqual([first.id, second.id].sort());
    const updated = await groups.updateMemberPermissions(
      platformUser.id,
      organization.id,
      first.id,
      student.id,
      { ...NO_FLAGS, readInvoices: true },
    );
    expect(updated.permissions).toEqual({ ...NO_FLAGS, readInvoices: true });
    // Administration is not membership: no invoice permissions result from it.
    await expect(
      prisma.organizationMembership.count({
        where: { userId: platformUser.id },
      }),
    ).resolves.toBe(0);
  });
});

describe("PlatformAdministrator PostgreSQL integration", () => {
  // The organization is created by the platform administrator with an
  // explicit first ADMIN, the only way an organization gets one.
  async function createdOrganization(
    global: { id: string },
    firstAdmin: { rut: string },
    slug = "provisioned",
  ) {
    const created = await createOrganizationService(prisma).createOrganization(
      global.id,
      {
        name: "Provisioned",
        slug,
        firstAdminRut: firstAdmin.rut,
      },
    );
    return created.organization;
  }

  it("allows only the global administrator to create organizations and an organization ADMIN to provision a temporary credential transactionally", async () => {
    const global = await persistence.createUser({
      name: "Global",
      rut: "12.345.678-5",
    });
    const organizationAdmin = await persistence.createUser({
      name: "Organization",
      rut: "12.345.679-3",
    });
    const plain = await persistence.createUser({
      name: "Plain",
      rut: "12.345.671-8",
    });
    const foreignAdmin = await persistence.createUser({
      name: "Foreign",
      rut: "12.345.672-6",
    });
    const foreignOrganization = await persistence.createOrganization({
      name: "Foreign Academy",
      slug: "foreign-academy",
    });
    await prisma.organizationMembership.create({
      data: {
        userId: foreignAdmin.id,
        organizationId: foreignOrganization.id,
        role: OrganizationRole.ADMIN,
      },
    });
    const organizations = createOrganizationService(prisma);
    const users = createUserService(prisma);
    await designatePlatformAdministrator(global);
    await expect(
      organizations.createOrganization(organizationAdmin.id, {
        name: "Denied",
        slug: "denied",
        firstAdminRut: organizationAdmin.rut,
      }),
    ).rejects.toMatchObject({ status: 403 });
    const organization = await createdOrganization(global, organizationAdmin);
    await prisma.organizationMembership.create({
      data: {
        userId: plain.id,
        organizationId: organization.id,
        role: OrganizationRole.USER,
      },
    });
    const input = {
      name: "Student",
      rut: "12345670K",
      role: OrganizationRole.USER,
    };
    await expect(
      users.provisionUser(plain.id, organization.id, input),
    ).rejects.toMatchObject({ status: 403 });
    // An administrator of another organization has no authority here.
    await expect(
      users.provisionUser(foreignAdmin.id, organization.id, input),
    ).rejects.toMatchObject({ status: 404 });
    const provisioned = await users.provisionUser(
      organizationAdmin.id,
      organization.id,
      input,
    );
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: provisioned.user.id },
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
    expect(provisioned.user.rut).toBe("12345670K");
    expect(stored.rut).toBe("12345670K");
    const generated = provisioned.temporaryPassword as string;
    expect(generated).toHaveLength(32);
    expect(stored.passwordHash).toMatch(/^scrypt\$/);
    expect(stored.passwordHash).not.toContain(generated);
    expect(stored.mustChangePassword).toBe(true);
    expect(stored.temporaryPasswordExpiresAt).toBeInstanceOf(Date);
    expect(membership.role).toBe(OrganizationRole.USER);
    expect(audit.map(({ type }) => type)).toContain("USER_PROVISIONED");
    expect(JSON.stringify(audit)).not.toContain(generated);
  });

  it("clears the temporary requirement, revokes every session and issues a rotated one after password change", async () => {
    const global = await persistence.createUser({
      name: "Global",
      rut: "12.345.678-5",
    });
    const organizationAdmin = await persistence.createUser({
      name: "Organization",
      rut: "12.345.671-8",
    });
    await designatePlatformAdministrator(global);
    const organization = await createdOrganization(global, organizationAdmin);
    const provisioned = await createUserService(prisma).provisionUser(
      organizationAdmin.id,
      organization.id,
      { name: "Student", rut: "123456793", role: OrganizationRole.USER },
    );
    const temporaryPassword = provisioned.temporaryPassword as string;
    const auth = createAuthService(prisma);
    const first = await auth.login({
      rut: "12.345.679-3",
      password: temporaryPassword,
    });
    const second = await auth.login({
      rut: "12.345.679-3",
      password: temporaryPassword,
    });
    expect((await auth.getProfile(first.sessionToken)).mustChangePassword).toBe(
      true,
    );
    // RP0-04: the change revokes every session and returns a rotated one.
    const rotated = await auth.changePassword!(first.sessionToken, {
      currentPassword: temporaryPassword,
      newPassword: "changed-password-123",
    });
    if (!rotated) throw new Error("expected a rotated session");
    expect(await auth.getProfile(rotated.sessionToken)).toMatchObject({
      mustChangePassword: false,
    });
    for (const revoked of [first, second]) {
      await expect(auth.getProfile(revoked.sessionToken)).rejects.toMatchObject(
        { status: 401 },
      );
    }
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: provisioned.user.id },
    });
    expect(stored.temporaryPasswordExpiresAt).toBeNull();
    expect(stored.mustChangePassword).toBe(false);
    expect(
      await prisma.platformAdministrativeAuditEvent.count({
        where: { targetUserId: stored.id, type: "PASSWORD_CHANGED" },
      }),
    ).toBe(1);
  });

  it("lists every organization only for the platform administrator and grants it administrative group access without membership", async () => {
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
    const organizations = createOrganizationService(prisma);
    await designatePlatformAdministrator(platformUser);
    const group = await groups.createGroup(
      organizationAdministrator.id,
      organization.id,
      { name: "Advanced topics" },
    );
    const expected = {
      id: organization.id,
      name: "AI Academy",
      slug: "ai-academy",
      description: null,
      enabled: true,
      createdAt: organization.createdAt.toISOString(),
    };

    await expect(
      organizations.listOrganizations(unauthorizedUser.id),
    ).resolves.toEqual([]);
    await expect(
      organizations.listOrganizations(platformUser.id),
    ).resolves.toEqual([expected]);
    await expect(
      organizations.listOrganizations(organizationAdministrator.id),
    ).resolves.toEqual([expected]);
    // Administrative authority only: the platform administrator administers
    // every existing organization without being a member of it.
    await expect(
      groups.listGroups(platformUser.id, organization.id),
    ).resolves.toEqual([expect.objectContaining({ id: group.id })]);
    await expect(
      groups.listMemberships(platformUser.id, organization.id, group.id),
    ).resolves.toEqual([]);
    await expect(
      groups.listGroups(platformUser.id, randomUUID()),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      prisma.organizationMembership.count({
        where: { userId: platformUser.id },
      }),
    ).resolves.toBe(0);
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

    await designatePlatformAdministrator(firstUser);

    await expect(
      designatePlatformAdministrator(secondUser),
    ).rejects.toBeInstanceOf(BootstrapRejectedError);
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
    const organizations = createOrganizationService(prisma);
    const actor = firstAdministrator;

    await organizations.createMembership(actor.id, organization.id, {
      rut: member.rut,
      role: OrganizationRole.USER,
    });
    await organizations.changeMembershipRole(
      actor.id,
      organization.id,
      member.id,
      OrganizationRole.ADMIN,
    );
    await organizations.changeMembershipRole(
      actor.id,
      organization.id,
      member.id,
      OrganizationRole.USER,
    );
    await organizations.removeMembership(actor.id, organization.id, member.id);

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
          actorUserId: actor.id,
          targetUserId: member.id,
          organizationId: organization.id,
          previousRole: null,
          role: OrganizationRole.USER,
        },
        {
          type: "ORGANIZATION_MEMBERSHIP_ROLE_CHANGED",
          actorUserId: actor.id,
          targetUserId: member.id,
          organizationId: organization.id,
          previousRole: OrganizationRole.USER,
          role: OrganizationRole.ADMIN,
        },
        {
          type: "ORGANIZATION_MEMBERSHIP_ROLE_CHANGED",
          actorUserId: actor.id,
          targetUserId: member.id,
          organizationId: organization.id,
          previousRole: OrganizationRole.ADMIN,
          role: OrganizationRole.USER,
        },
        {
          type: "ORGANIZATION_MEMBERSHIP_REMOVED",
          actorUserId: actor.id,
          targetUserId: member.id,
          organizationId: organization.id,
          previousRole: OrganizationRole.USER,
          role: null,
        },
      ]),
    );
  });

  it("rolls back membership creation when the audit insert fails", async () => {
    const administrator = await persistence.createUser({
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
    await prisma.organizationMembership.create({
      data: {
        userId: administrator.id,
        organizationId: organization.id,
        role: OrganizationRole.ADMIN,
      },
    });
    const organizations = createOrganizationService(prisma);

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
        organizations.createMembership(administrator.id, organization.id, {
          rut: member.rut,
          role: OrganizationRole.USER,
        }),
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
      ["bootstrap", firstUser.id, "--confirm-bootstrap"],
      ["transfer", secondUser.id],
      ["transfer", secondUser.id, "--confirm-bootstrap"],
    ]) {
      expect(() => parsePlatformAdministratorCommand(arguments_)).toThrow();
    }
    expect(await prisma.platformAdministrator.count()).toBe(0);
    expect(await prisma.platformAdministrativeAuditEvent.count()).toBe(0);

    await designatePlatformAdministrator(firstUser);
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

  it("rejects organization membership administration by non-ADMINs and lets the platform administrator administer without membership", async () => {
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
    const organizations = createOrganizationService(prisma);
    await designatePlatformAdministrator(platformUser);

    for (const [actor, status] of [
      [unauthorizedUser, 404],
      [member, 403],
    ] as const) {
      await expect(
        organizations.createMembership(actor.id, organization.id, {
          rut: unauthorizedUser.rut,
          role: OrganizationRole.USER,
        }),
      ).rejects.toMatchObject({ status });
      await expect(
        organizations.changeMembershipRole(
          actor.id,
          organization.id,
          member.id,
          OrganizationRole.ADMIN,
        ),
      ).rejects.toMatchObject({ status });
      await expect(
        organizations.removeMembership(actor.id, organization.id, member.id),
      ).rejects.toMatchObject({ status });
    }
    expect(await prisma.organizationMembership.count()).toBe(1);

    // The platform administrator administers every existing organization.
    await expect(
      organizations.createMembership(platformUser.id, organization.id, {
        rut: unauthorizedUser.rut,
        role: OrganizationRole.USER,
      }),
    ).resolves.toMatchObject({ userId: unauthorizedUser.id, role: "USER" });
    await expect(
      organizations.createMembership(platformUser.id, randomUUID(), {
        rut: member.rut,
        role: OrganizationRole.USER,
      }),
    ).rejects.toMatchObject({ status: 404 });
    // Still no membership of its own, hence no invoice permissions.
    await expect(
      prisma.organizationMembership.count({
        where: { userId: platformUser.id },
      }),
    ).resolves.toBe(0);
  });

  it("retains an organization ADMIN during parallel demotion and removal attempts", async () => {
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
    const organizations = createOrganizationService(prisma);

    // Each administrator acts on their own membership, so the two attempts
    // can only both succeed by leaving the organization without an ADMIN.
    const demotions = await Promise.allSettled(
      [firstAdministrator, secondAdministrator].map((administrator) =>
        organizations.changeMembershipRole(
          administrator.id,
          organization.id,
          administrator.id,
          OrganizationRole.USER,
        ),
      ),
    );
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
    const removals = await Promise.allSettled(
      [firstAdministrator, secondAdministrator].map((administrator) =>
        organizations.removeMembership(
          administrator.id,
          organization.id,
          administrator.id,
        ),
      ),
    );
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
    scopeKey: groupId,
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
