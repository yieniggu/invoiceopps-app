import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  OrganizationRole,
  PrismaClient,
} from "../src/generated/prisma/client.js";
import { AuthError, createAuthService } from "../src/auth.js";
import { createOrganizationPersistence } from "../src/organization-persistence.js";
import { createGroupService } from "../src/groups.js";
import { createInvoiceService } from "../src/invoices.js";
import { createBusinessPolicyService } from "../src/business-policies.js";
import { seedLocalDemonstration } from "../src/local-demonstration.js";
import { parsePlatformAdministratorCommand } from "../src/platform-administrator-command.js";
import { createPlatformAdministratorService } from "../src/platform-administrator.js";
import { createResourceService } from "../src/resources.js";
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
  // TRUNCATE bypasses the append-only DELETE trigger only while resetting isolated test data.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "PlatformAdministrativeAuditEvent", "PlatformAdministrator"',
  );
  await prisma.session.deleteMany();
  await prisma.decisionEvent.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.businessPolicy.deleteMany();
  await prisma.resourceReference.deleteMany();
  await prisma.groupMembership.deleteMany();
  await prisma.group.deleteMany();
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
          role: OrganizationRole.STUDENT,
        },
        {
          userId: outsider.id,
          organizationId: secondOrganization.id,
          role: OrganizationRole.STUDENT,
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
      { id: admin.id, name: "Ada Lovelace", rut: "123456785" },
      { id: student.id, name: "Grace Hopper", rut: "123456793" },
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

describe("PlatformAdministrator PostgreSQL integration", () => {
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
      OrganizationRole.STUDENT,
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
      OrganizationRole.STUDENT,
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
          role: OrganizationRole.STUDENT,
        },
        {
          type: "ORGANIZATION_MEMBERSHIP_ROLE_CHANGED",
          actorUserId: platformUser.id,
          targetUserId: member.id,
          organizationId: organization.id,
          previousRole: OrganizationRole.STUDENT,
          role: OrganizationRole.ADMIN,
        },
        {
          type: "ORGANIZATION_MEMBERSHIP_ROLE_CHANGED",
          actorUserId: platformUser.id,
          targetUserId: member.id,
          organizationId: organization.id,
          previousRole: OrganizationRole.ADMIN,
          role: OrganizationRole.STUDENT,
        },
        {
          type: "ORGANIZATION_MEMBERSHIP_REMOVED",
          actorUserId: platformUser.id,
          targetUserId: member.id,
          organizationId: organization.id,
          previousRole: OrganizationRole.STUDENT,
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
          OrganizationRole.STUDENT,
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
        role: OrganizationRole.STUDENT,
      },
    });
    const platformAdministrators = createPlatformAdministratorService(prisma);
    await platformAdministrators.bootstrap(platformUser.id);

    await expect(
      platformAdministrators.createMembership(
        unauthorizedUser.id,
        organization.id,
        unauthorizedUser.id,
        OrganizationRole.STUDENT,
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
        OrganizationRole.STUDENT,
      ),
      platformAdministrators.changeMembershipRole(
        platformUser.id,
        organization.id,
        secondAdministrator.id,
        OrganizationRole.STUDENT,
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

describe("APP-05 PostgreSQL resource ownership", () => {
  it("lists only resources from an accessible individual or group owner context", async () => {
    const organization = await persistence.createOrganization({
      name: "AI Academy",
      slug: "ai-academy",
    });
    const member = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    const otherMember = await persistence.createUser({
      name: "Grace Hopper",
      rut: "12.345.679-3",
    });
    await prisma.organizationMembership.createMany({
      data: [
        {
          userId: member.id,
          organizationId: organization.id,
          role: OrganizationRole.ADMIN,
        },
        {
          userId: otherMember.id,
          organizationId: organization.id,
          role: OrganizationRole.STUDENT,
        },
      ],
    });
    const groups = createGroupService(prisma);
    const group = await groups.createGroup(member.id, organization.id, {
      name: "Advanced topics",
    });
    await prisma.resourceReference.createMany({
      data: [
        {
          organizationId: organization.id,
          ownerType: "USER",
          ownerId: member.id,
          createdByUserId: member.id,
          type: "ml-experiment",
          label: "Personal experiment",
        },
        {
          organizationId: organization.id,
          ownerType: "GROUP",
          ownerId: group.id,
          createdByUserId: member.id,
          type: "ml-model",
          label: "Group model",
        },
      ],
    });
    const resources = createResourceService(prisma);

    await expect(
      resources.listResources(member.id, {
        organizationId: organization.id,
        ownerType: "user",
        ownerId: member.id,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        label: "Personal experiment",
        ownerType: "user",
      }),
    ]);
    await expect(
      resources.listResources(member.id, {
        organizationId: organization.id,
        ownerType: "group",
        ownerId: group.id,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ label: "Group model", ownerType: "group" }),
    ]);
    await expect(
      resources.listResources(member.id, {
        organizationId: organization.id,
        ownerType: "user",
        ownerId: otherMember.id,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("APP-06 PostgreSQL invoice domain", () => {
  it("filters owner-scoped invoices and atomically snapshots a permitted decision audit", async () => {
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
          role: OrganizationRole.STUDENT,
        },
        {
          userId: otherUser.id,
          organizationId: organization.id,
          role: OrganizationRole.STUDENT,
        },
      ],
    });
    await prisma.invoice.createMany({
      data: [
        {
          invoiceId: "INV-001",
          organizationId: organization.id,
          ownerType: "USER",
          ownerId: actor.id,
          createdByUserId: actor.id,
          vendorName: "Acme Ltd.",
          invoiceAmountCents: 500_000,
          hasPurchaseOrder: true,
          threeWayMatch: true,
          vendorTenureDays: 365,
          previousIncidents12m: 0,
          bankAccountRecentlyChanged: false,
          amountVsVendorMedian: 1,
          countryRisk: "medium",
        },
        {
          invoiceId: "INV-002",
          organizationId: organization.id,
          ownerType: "USER",
          ownerId: otherUser.id,
          createdByUserId: otherUser.id,
          vendorName: "Other vendor",
          invoiceAmountCents: 1,
          hasPurchaseOrder: true,
          threeWayMatch: true,
          vendorTenureDays: 1,
          previousIncidents12m: 0,
          bankAccountRecentlyChanged: false,
          amountVsVendorMedian: 1,
          countryRisk: "low",
        },
        {
          invoiceId: "INV-003",
          organizationId: organization.id,
          ownerType: "USER",
          ownerId: actor.id,
          createdByUserId: actor.id,
          vendorName: "High amount vendor",
          invoiceAmountCents: 500_001,
          hasPurchaseOrder: true,
          threeWayMatch: true,
          vendorTenureDays: 1,
          previousIncidents12m: 0,
          bankAccountRecentlyChanged: false,
          amountVsVendorMedian: 1,
          countryRisk: "low",
        },
        {
          invoiceId: "INV-004",
          organizationId: organization.id,
          ownerType: "USER",
          ownerId: actor.id,
          createdByUserId: actor.id,
          vendorName: "No purchase order vendor",
          invoiceAmountCents: 1,
          hasPurchaseOrder: false,
          threeWayMatch: true,
          vendorTenureDays: 1,
          previousIncidents12m: 0,
          bankAccountRecentlyChanged: false,
          amountVsVendorMedian: 1,
          countryRisk: "low",
        },
        {
          invoiceId: "INV-005",
          organizationId: organization.id,
          ownerType: "USER",
          ownerId: actor.id,
          createdByUserId: actor.id,
          vendorName: "No three-way match vendor",
          invoiceAmountCents: 1,
          hasPurchaseOrder: true,
          threeWayMatch: false,
          vendorTenureDays: 1,
          previousIncidents12m: 0,
          bankAccountRecentlyChanged: false,
          amountVsVendorMedian: 1,
          countryRisk: "low",
        },
        {
          invoiceId: "INV-006",
          organizationId: organization.id,
          ownerType: "USER",
          ownerId: actor.id,
          createdByUserId: actor.id,
          vendorName: "Risk ignored vendor",
          invoiceAmountCents: 500_000,
          hasPurchaseOrder: true,
          threeWayMatch: true,
          vendorTenureDays: 0,
          previousIncidents12m: 99,
          bankAccountRecentlyChanged: true,
          amountVsVendorMedian: 99,
          countryRisk: "high",
        },
      ],
    });
    const invoices = createInvoiceService(prisma);
    const context = {
      organizationId: organization.id,
      ownerType: "user" as const,
      ownerId: actor.id,
    };

    await expect(
      invoices.listInvoices(actor.id, context, { q: "acme", limit: 50 }),
    ).resolves.toMatchObject({
      invoices: [{ invoiceId: "INV-001" }],
      nextCursor: null,
    });
    const decided = await invoices.decideInvoice(actor, context, "INV-001", {
      mode: "RULE_V1",
    });
    await prisma.user.update({
      where: { id: actor.id },
      data: { name: "Ada Updated", rut: "123456785" },
    });

    expect(decided).toMatchObject({
      invoice: { status: "AUTO_PROCESSED" },
      auditEvent: {
        ruleVersion: "invoice-rules-v1",
        actor: { name: "Ada Lovelace", rut: "123456785" },
      },
    });
    await expect(
      invoices.getInvoice(actor.id, context, "INV-001"),
    ).resolves.toMatchObject({
      auditEvents: [{ actor: { name: "Ada Lovelace", rut: "123456785" } }],
    });
    await expect(
      invoices.decideInvoice(actor, context, "INV-001", { mode: "RULE_V1" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      invoices.decideInvoice(actor, context, "INV-003", { mode: "RULE_V1" }),
    ).resolves.toMatchObject({ invoice: { status: "MANUAL_REVIEW" } });
    await expect(
      invoices.decideInvoice(actor, context, "INV-004", { mode: "RULE_V1" }),
    ).resolves.toMatchObject({ invoice: { status: "MANUAL_REVIEW" } });
    await expect(
      invoices.decideInvoice(actor, context, "INV-005", { mode: "RULE_V1" }),
    ).resolves.toMatchObject({ invoice: { status: "MANUAL_REVIEW" } });
    await expect(
      invoices.decideInvoice(actor, context, "INV-006", { mode: "RULE_V1" }),
    ).resolves.toMatchObject({ invoice: { status: "AUTO_PROCESSED" } });
    await expect(
      invoices.getInvoice(actor.id, context, "INV-002"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      invoices.listInvoices(
        actor.id,
        {
          organizationId: organization.id,
          ownerType: "user",
          ownerId: otherUser.id,
        },
        { q: "", limit: 50 },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("applies a versioned probability policy with an equality threshold and snapshots local demonstration input", async () => {
    const organization = await persistence.createOrganization({
      name: "Policy Academy",
      slug: "policy-academy",
    });
    const actor = await persistence.createUser({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
    });
    await prisma.organizationMembership.create({
      data: {
        userId: actor.id,
        organizationId: organization.id,
        role: OrganizationRole.STUDENT,
      },
    });
    const context = {
      organizationId: organization.id,
      ownerType: "user" as const,
      ownerId: actor.id,
    };
    await prisma.invoice.createMany({
      data: [
        {
          invoiceId: "INV-POLICY-EQUAL",
          organizationId: organization.id,
          ownerType: "USER",
          ownerId: actor.id,
          createdByUserId: actor.id,
          vendorName: "Policy vendor",
          invoiceAmountCents: 1,
          hasPurchaseOrder: true,
          threeWayMatch: true,
          vendorTenureDays: 1,
          previousIncidents12m: 0,
          bankAccountRecentlyChanged: false,
          amountVsVendorMedian: 1,
          countryRisk: "low",
          policyProbability: 0.8,
          policyProbabilitySource: "LOCAL_DEMONSTRATION",
        },
        {
          invoiceId: "INV-POLICY-MISSING",
          organizationId: organization.id,
          ownerType: "USER",
          ownerId: actor.id,
          createdByUserId: actor.id,
          vendorName: "Missing probability vendor",
          invoiceAmountCents: 1,
          hasPurchaseOrder: true,
          threeWayMatch: true,
          vendorTenureDays: 1,
          previousIncidents12m: 0,
          bankAccountRecentlyChanged: false,
          amountVsVendorMedian: 1,
          countryRisk: "low",
        },
      ],
    });
    const policies = createBusinessPolicyService(prisma);
    const invoices = createInvoiceService(prisma);
    await policies.createPolicy(actor.id, context, {
      version: "ml-policy-v1",
      manualReviewThreshold: 0.8,
    });

    await expect(
      invoices.decideInvoice(actor, context, "INV-POLICY-EQUAL", {
        mode: "PROBABILITY_POLICY",
        policyVersion: "ml-policy-v1",
      }),
    ).resolves.toMatchObject({
      invoice: { status: "MANUAL_REVIEW" },
      auditEvent: {
        mode: "PROBABILITY_POLICY",
        policyVersion: "ml-policy-v1",
        manualReviewThreshold: 0.8,
        policyProbability: 0.8,
        policyProbabilitySource: "LOCAL_DEMONSTRATION",
      },
    });
    await policies.updatePolicy(actor.id, context, "ml-policy-v1", {
      manualReviewThreshold: 0.9,
    });
    await prisma.invoice.create({
      data: {
        invoiceId: "INV-POLICY-FUTURE",
        organizationId: organization.id,
        ownerType: "USER",
        ownerId: actor.id,
        createdByUserId: actor.id,
        vendorName: "Updated policy vendor",
        invoiceAmountCents: 1,
        hasPurchaseOrder: true,
        threeWayMatch: true,
        vendorTenureDays: 1,
        previousIncidents12m: 0,
        bankAccountRecentlyChanged: false,
        amountVsVendorMedian: 1,
        countryRisk: "low",
        policyProbability: 0.8,
        policyProbabilitySource: "LOCAL_DEMONSTRATION",
      },
    });
    await expect(
      invoices.decideInvoice(actor, context, "INV-POLICY-FUTURE", {
        mode: "PROBABILITY_POLICY",
        policyVersion: "ml-policy-v1",
      }),
    ).resolves.toMatchObject({ invoice: { status: "AUTO_PROCESSED" } });
    await expect(
      invoices.decideInvoice(actor, context, "INV-POLICY-MISSING", {
        mode: "PROBABILITY_POLICY",
        policyVersion: "ml-policy-v1",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      prisma.invoice.findFirstOrThrow({
        where: { invoiceId: "INV-POLICY-MISSING" },
      }),
    ).resolves.toMatchObject({ status: "PENDING" });
    await expect(prisma.decisionEvent.count()).resolves.toBe(2);
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
          role: OrganizationRole.STUDENT,
        },
        {
          userId: groupStudent.id,
          organizationId: organization.id,
          role: OrganizationRole.STUDENT,
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

  it("sets up two idempotent local demonstration invoices with opposite policy outcomes", async () => {
    const seeded = await seedLocalDemonstration(prisma);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: seeded.userId },
      select: { id: true, name: true, rut: true },
    });
    const context = {
      organizationId: seeded.organizationId,
      ownerType: "user" as const,
      ownerId: user.id,
    };
    const invoices = createInvoiceService(prisma);

    await expect(
      invoices.decideInvoice(user, context, "DEMO-RULE-AUTO-POLICY-MANUAL", {
        mode: "RULE_V1",
      }),
    ).resolves.toMatchObject({ invoice: { status: "AUTO_PROCESSED" } });
    await seedLocalDemonstration(prisma);
    await expect(
      invoices.decideInvoice(user, context, "DEMO-RULE-AUTO-POLICY-MANUAL", {
        mode: "PROBABILITY_POLICY",
        policyVersion: "ml-policy-v1",
      }),
    ).resolves.toMatchObject({ invoice: { status: "MANUAL_REVIEW" } });
    await seedLocalDemonstration(prisma);
    await expect(
      invoices.decideInvoice(user, context, "DEMO-RULE-MANUAL-POLICY-AUTO", {
        mode: "RULE_V1",
      }),
    ).resolves.toMatchObject({ invoice: { status: "MANUAL_REVIEW" } });
    await seedLocalDemonstration(prisma);
    await expect(
      invoices.decideInvoice(user, context, "DEMO-RULE-MANUAL-POLICY-AUTO", {
        mode: "PROBABILITY_POLICY",
        policyVersion: "ml-policy-v1",
      }),
    ).resolves.toMatchObject({ invoice: { status: "AUTO_PROCESSED" } });
  });

  it("authorizes group owners and traverses stable cursor pages", async () => {
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
          role: OrganizationRole.STUDENT,
        },
        {
          userId: nonMember.id,
          organizationId: organization.id,
          role: OrganizationRole.STUDENT,
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
      data: [
        {
          invoiceId: "INV-GROUP",
          organizationId: organization.id,
          ownerType: "GROUP",
          ownerId: group.id,
          createdByUserId: member.id,
          vendorName: "Group vendor",
          invoiceAmountCents: 1,
          hasPurchaseOrder: true,
          threeWayMatch: true,
          vendorTenureDays: 1,
          previousIncidents12m: 0,
          bankAccountRecentlyChanged: false,
          amountVsVendorMedian: 1,
          countryRisk: "low",
        },
        ...[1, 2, 3].map((number) => ({
          invoiceId: `INV-CURSOR-${number}`,
          organizationId: organization.id,
          ownerType: "USER" as const,
          ownerId: member.id,
          createdByUserId: member.id,
          vendorName: `Cursor vendor ${number}`,
          invoiceAmountCents: 1,
          hasPurchaseOrder: true,
          threeWayMatch: true,
          vendorTenureDays: 1,
          previousIncidents12m: 0,
          bankAccountRecentlyChanged: false,
          amountVsVendorMedian: 1,
          countryRisk: "low",
          createdAt: new Date(`2026-09-21T00:00:0${number}.000Z`),
        })),
      ],
    });
    const invoices = createInvoiceService(prisma);
    const groupContext = {
      organizationId: organization.id,
      ownerType: "group" as const,
      ownerId: group.id,
    };

    await expect(
      invoices.listInvoices(member.id, groupContext, { q: "", limit: 50 }),
    ).resolves.toMatchObject({ invoices: [{ invoiceId: "INV-GROUP" }] });
    await expect(
      invoices.listInvoices(nonMember.id, groupContext, { q: "", limit: 50 }),
    ).rejects.toMatchObject({ status: 404 });

    const individualContext = {
      organizationId: organization.id,
      ownerType: "user" as const,
      ownerId: member.id,
    };
    const firstPage = await invoices.listInvoices(
      member.id,
      individualContext,
      {
        q: "Cursor vendor",
        limit: 1,
      },
    );
    const secondPage = await invoices.listInvoices(
      member.id,
      individualContext,
      {
        q: "Cursor vendor",
        cursor: firstPage.nextCursor ?? undefined,
        limit: 1,
      },
    );
    const thirdPage = await invoices.listInvoices(
      member.id,
      individualContext,
      {
        q: "Cursor vendor",
        cursor: secondPage.nextCursor ?? undefined,
        limit: 1,
      },
    );

    expect(firstPage).toMatchObject({
      invoices: [{ invoiceId: "INV-CURSOR-3" }],
    });
    expect(secondPage).toMatchObject({
      invoices: [{ invoiceId: "INV-CURSOR-2" }],
    });
    expect(thirdPage).toMatchObject({
      invoices: [{ invoiceId: "INV-CURSOR-1" }],
      nextCursor: null,
    });
  });
});
