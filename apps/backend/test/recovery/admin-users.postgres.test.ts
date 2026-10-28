import { randomUUID } from "node:crypto";
import pg from "pg";
import request from "../support/request.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { formatRut } from "../../src/rut.js";
import {
  ALL_FLAGS,
  membershipFixtures,
  NO_FLAGS,
  randomRut,
  type TestUser,
} from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

const url = recoveryTestDatabaseUrl();

const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const app = createApp(database, auth);
const {
  makeUser,
  makeOrg,
  join,
  makeGroup,
  cookieFor,
  call,
  designatePlatformAdministrator,
} = membershipFixtures({ prisma, client, auth, app, url });

let platform: TestUser;
let platformCookie: string;

beforeAll(async () => {
  await client.connect();
  platform = await makeUser("Platform Administrator");
  await designatePlatformAdministrator(platform.id);
  platformCookie = await cookieFor(platform);
});
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

async function twoOrganizations() {
  const orgA = await makeOrg("adm-a");
  const orgB = await makeOrg("adm-b");
  const groupA1 = await makeGroup(orgA.id, "A1");
  const groupA2 = await makeGroup(orgA.id, "A2");
  const groupB1 = await makeGroup(orgB.id, "B1");
  return { orgA, orgB, groupA1, groupA2, groupB1 };
}

async function countsFor(rawRut: string) {
  const user = await prisma.user.findUnique({ where: { rut: rawRut } });
  if (!user) return { user: 0, organizations: 0, groups: 0, audit: 0 };
  return {
    user: 1,
    organizations: await prisma.organizationMembership.count({
      where: { userId: user.id },
    }),
    groups: await prisma.groupMembership.count({ where: { userId: user.id } }),
    audit: await prisma.platformAdministrativeAuditEvent.count({
      where: { targetUserId: user.id },
    }),
  };
}

describe("POST /api/v1/admin/users", () => {
  it("creates the user with every organization and group membership, no-store, and a working temporary password", async () => {
    const { orgA, orgB, groupA1, groupA2, groupB1 } = await twoOrganizations();
    const rut = formatRut(randomRut());
    const orgFlags = { ...NO_FLAGS, readInvoices: true };
    const groupFlags = { ...NO_FLAGS, createInvoices: true };

    const response = await call("post", "/admin/users", platformCookie, {
      name: "New Person",
      rut,
      memberships: [
        {
          organizationId: orgA.id,
          role: "USER",
          permissions: orgFlags,
          groups: [
            { groupId: groupA1.id, permissions: groupFlags },
            { groupId: groupA2.id },
          ],
        },
        {
          organizationId: orgB.id,
          role: "ADMIN",
          groups: [{ groupId: groupB1.id, permissions: ALL_FLAGS }],
        },
      ],
    });

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    const userId = response.body.user.id as string;
    expect(response.body.user).toMatchObject({
      name: "New Person",
      mustChangePassword: true,
    });
    expect(response.body.memberships).toEqual([
      {
        organizationId: orgA.id,
        role: "USER",
        permissions: orgFlags,
        groups: [
          { groupId: groupA1.id, permissions: groupFlags },
          { groupId: groupA2.id, permissions: NO_FLAGS },
        ],
      },
      {
        organizationId: orgB.id,
        role: "ADMIN",
        permissions: NO_FLAGS,
        groups: [{ groupId: groupB1.id, permissions: ALL_FLAGS }],
      },
    ]);
    expect(typeof response.body.temporaryPassword).toBe("string");

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    expect(stored.mustChangePassword).toBe(true);
    expect(stored.temporaryPasswordExpiresAt!.getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(stored.passwordHash).not.toContain(response.body.temporaryPassword);
    expect(await countsFor(stored.rut)).toMatchObject({
      organizations: 2,
      groups: 3,
    });

    const audit = await prisma.platformAdministrativeAuditEvent.findMany({
      where: { targetUserId: userId },
    });
    const byType = (type: string) =>
      audit.filter((event) => event.type === type);
    expect(byType("USER_PROVISIONED")).toHaveLength(1);
    expect(byType("USER_PROVISIONED")[0]).toMatchObject({
      actorUserId: platform.id,
      organizationId: null,
      groupId: null,
    });
    expect(byType("ORGANIZATION_MEMBERSHIP_CREATED")).toHaveLength(2);
    expect(
      byType("GROUP_MEMBERSHIP_CREATED")
        .map((event) => [event.organizationId, event.groupId])
        .sort(),
    ).toEqual(
      [
        [orgA.id, groupA1.id],
        [orgA.id, groupA2.id],
        [orgB.id, groupB1.id],
      ].sort(),
    );
    expect(audit).toHaveLength(6);

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ rut, password: response.body.temporaryPassword });
    expect(login.status).toBe(200);
    const profile = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", String(login.headers["set-cookie"]).split(";")[0]);
    expect(profile.body.profile.mustChangePassword).toBe(true);
    expect(profile.body.profile.memberships).toHaveLength(2);
  });

  it("accepts an admin-defined temporary password: no echo, forced change, never in audit or logs", async () => {
    const rut = formatRut(randomRut());
    const defined = "Defined-temp-pass-77";
    const spies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    let loggedText = "";
    let response;
    try {
      response = await call("post", "/admin/users", platformCookie, {
        name: "Defined Pass",
        rut,
        memberships: [],
        temporaryPassword: defined,
      });
      loggedText = JSON.stringify(spies.map((spy) => spy.mock.calls));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expect(response.body).not.toHaveProperty("temporaryPassword");
    expect(JSON.stringify(response.body)).not.toContain(defined);
    expect(loggedText).not.toContain(defined);

    const userId = response.body.user.id as string;
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    expect(stored.mustChangePassword).toBe(true);
    expect(stored.temporaryPasswordExpiresAt!.getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(stored.passwordHash).not.toContain(defined);
    const audit = await prisma.platformAdministrativeAuditEvent.findMany({
      where: { targetUserId: userId },
    });
    expect(JSON.stringify(audit)).not.toContain(defined);

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ rut, password: defined });
    expect(login.status).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const profile = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", cookie);
    expect(profile.body.profile.mustChangePassword).toBe(true);

    const changed = await request(app)
      .post("/api/v1/auth/change-password")
      .set({ Host: "127.0.0.1", Origin: "http://127.0.0.1" })
      .set("Cookie", cookie)
      .send({ currentPassword: defined, newPassword: "A-new-password-99" });
    expect(changed.status).toBe(204);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    expect(after.mustChangePassword).toBe(false);
  });

  it("creates a user with no membership", async () => {
    const rut = formatRut(randomRut());

    const response = await call("post", "/admin/users", platformCookie, {
      name: "Floating",
      rut,
      memberships: [],
    });

    expect(response.status).toBe(201);
    expect(response.body.memberships).toEqual([]);
    expect(
      await prisma.platformAdministrativeAuditEvent.count({
        where: { targetUserId: response.body.user.id },
      }),
    ).toBe(1);
  });

  it("answers 403 to an organization ADMIN, a USER and a user without memberships, persisting nothing", async () => {
    const org = await makeOrg("adm-forbidden");
    const admin = await makeUser();
    const member = await makeUser();
    const nobody = await makeUser();
    await join(admin.id, org.id, "ADMIN");
    await join(member.id, org.id, "USER");
    const rawRut = randomRut();

    for (const actor of [admin, member, nobody]) {
      const response = await call(
        "post",
        "/admin/users",
        await cookieFor(actor),
        {
          name: "Nope",
          rut: formatRut(rawRut),
          memberships: [{ organizationId: org.id, role: "USER" }],
        },
      );
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
    expect(await countsFor(rawRut)).toEqual({
      user: 0,
      organizations: 0,
      groups: 0,
      audit: 0,
    });
  });

  it("answers 403 ONBOARDING_REQUIRED to a platform administrator with a pending temporary password", async () => {
    await prisma.user.update({
      where: { id: platform.id },
      data: {
        mustChangePassword: true,
        temporaryPasswordExpiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    try {
      const response = await call("post", "/admin/users", platformCookie, {
        name: "Nope",
        rut: formatRut(randomRut()),
        memberships: [],
      });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("ONBOARDING_REQUIRED");
    } finally {
      await prisma.user.update({
        where: { id: platform.id },
        data: { mustChangePassword: false, temporaryPasswordExpiresAt: null },
      });
    }
  });

  it("rolls everything back when one group belongs to another organization (404)", async () => {
    const { orgA, orgB, groupA1, groupB1 } = await twoOrganizations();
    const rawRut = randomRut();

    const response = await call("post", "/admin/users", platformCookie, {
      name: "Rollback",
      rut: formatRut(rawRut),
      memberships: [
        {
          organizationId: orgA.id,
          role: "USER",
          groups: [{ groupId: groupA1.id }],
        },
        {
          organizationId: orgB.id,
          role: "USER",
          // groupA1 does not belong to organization B.
          groups: [{ groupId: groupB1.id }, { groupId: groupA1.id }],
        },
      ],
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(await countsFor(rawRut)).toEqual({
      user: 0,
      organizations: 0,
      groups: 0,
      audit: 0,
    });
  });

  it.each([
    ["a missing organization", () => randomUUID()],
    ["a missing group", () => randomUUID()],
  ])("rolls everything back for %s (404)", async (label, missing) => {
    const { orgA, groupA1 } = await twoOrganizations();
    const rawRut = randomRut();
    const memberships =
      label === "a missing organization"
        ? [
            {
              organizationId: orgA.id,
              role: "USER",
              groups: [{ groupId: groupA1.id }],
            },
            { organizationId: missing(), role: "USER" },
          ]
        : [
            {
              organizationId: orgA.id,
              role: "USER",
              groups: [{ groupId: groupA1.id }, { groupId: missing() }],
            },
          ];

    const response = await call("post", "/admin/users", platformCookie, {
      name: "Rollback",
      rut: formatRut(rawRut),
      memberships,
    });

    expect(response.status).toBe(404);
    expect(await countsFor(rawRut)).toEqual({
      user: 0,
      organizations: 0,
      groups: 0,
      audit: 0,
    });
  });

  it("answers 409 USER_CONFLICT for a duplicate RUT and leaves the existing user untouched", async () => {
    const { orgA, groupA1 } = await twoOrganizations();
    const existing = await makeUser("Existing");
    const before = await countsFor(existing.rawRut);

    const response = await call("post", "/admin/users", platformCookie, {
      name: "Clone",
      rut: existing.rut,
      memberships: [
        {
          organizationId: orgA.id,
          role: "ADMIN",
          groups: [{ groupId: groupA1.id }],
        },
      ],
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("USER_CONFLICT");
    expect(await countsFor(existing.rawRut)).toEqual(before);
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: orgA.id },
      }),
    ).toBe(0);
  });

  it.each([
    ["a duplicate organizationId", "dup-org"],
    ["a duplicate groupId within an organization", "dup-group"],
  ])("rejects %s with 400 and persists nothing", async (_label, kind) => {
    const { orgA, groupA1 } = await twoOrganizations();
    const rawRut = randomRut();
    const memberships =
      kind === "dup-org"
        ? [
            { organizationId: orgA.id, role: "USER" },
            { organizationId: orgA.id, role: "ADMIN" },
          ]
        : [
            {
              organizationId: orgA.id,
              role: "USER",
              groups: [{ groupId: groupA1.id }, { groupId: groupA1.id }],
            },
          ];

    const response = await call("post", "/admin/users", platformCookie, {
      name: "Dup",
      rut: formatRut(rawRut),
      memberships,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect((await countsFor(rawRut)).user).toBe(0);
  });
});

describe("POST /api/v1/organizations/{organizationId}/users with permissions and groups", () => {
  async function adminOf() {
    const { orgA, orgB, groupA1, groupA2, groupB1 } = await twoOrganizations();
    const admin = await makeUser();
    await join(admin.id, orgA.id, "ADMIN");
    return { orgA, orgB, groupA1, groupA2, groupB1, admin };
  }

  it("stays backwards compatible: {name, rut, role} creates a membership with all flags false", async () => {
    const { orgA, admin } = await adminOf();

    const response = await call(
      "post",
      `/organizations/${orgA.id}/users`,
      await cookieFor(admin),
      { name: "Plain", rut: formatRut(randomRut()), role: "USER" },
    );

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expect(response.body.membership).toEqual({
      userId: response.body.user.id,
      organizationId: orgA.id,
      role: "USER",
      permissions: NO_FLAGS,
    });
    expect(response.body.groups).toEqual([]);
  });

  it("creates the user, the organization permissions and the group memberships in one transaction", async () => {
    const { orgA, groupA1, groupA2, admin } = await adminOf();
    const orgFlags = {
      ...NO_FLAGS,
      readInvoices: true,
      deleteOwnInvoices: true,
    };
    const groupFlags = { ...NO_FLAGS, createInvoices: true };

    const response = await call(
      "post",
      `/organizations/${orgA.id}/users`,
      await cookieFor(admin),
      {
        name: "Granted",
        rut: formatRut(randomRut()),
        role: "USER",
        permissions: orgFlags,
        groups: [
          { groupId: groupA1.id, permissions: groupFlags },
          { groupId: groupA2.id },
        ],
      },
    );

    expect(response.status).toBe(201);
    expect(response.body.membership.permissions).toEqual(orgFlags);
    expect(response.body.groups).toEqual([
      { groupId: groupA1.id, permissions: groupFlags },
      { groupId: groupA2.id, permissions: NO_FLAGS },
    ]);
    const userId = response.body.user.id as string;
    expect(
      await prisma.groupMembership.count({
        where: { userId, organizationId: orgA.id },
      }),
    ).toBe(2);
    const events = await prisma.platformAdministrativeAuditEvent.findMany({
      where: { targetUserId: userId },
    });
    expect(
      events.filter((event) => event.type === "USER_PROVISIONED"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "GROUP_MEMBERSHIP_CREATED"),
    ).toHaveLength(2);
  });

  it("rejects a group of another organization with 404 and persists nothing", async () => {
    const { orgA, groupA1, groupB1, admin } = await adminOf();
    const rawRut = randomRut();

    const response = await call(
      "post",
      `/organizations/${orgA.id}/users`,
      await cookieFor(admin),
      {
        name: "Foreign group",
        rut: formatRut(rawRut),
        role: "USER",
        groups: [{ groupId: groupA1.id }, { groupId: groupB1.id }],
      },
    );

    expect(response.status).toBe(404);
    expect(await countsFor(rawRut)).toEqual({
      user: 0,
      organizations: 0,
      groups: 0,
      audit: 0,
    });
  });

  it("allows the platform administrator and rejects a USER member or a foreign ADMIN before hashing", async () => {
    const { orgA, groupA1 } = await adminOf();
    const member = await makeUser();
    await join(member.id, orgA.id, "USER");
    const foreignAdmin = await makeUser();
    const otherOrg = await makeOrg("adm-foreign");
    await join(foreignAdmin.id, otherOrg.id, "ADMIN");
    const body = (rawRut: string) => ({
      name: "Someone",
      rut: formatRut(rawRut),
      role: "USER",
      groups: [{ groupId: groupA1.id }],
    });
    const path = `/organizations/${orgA.id}/users`;

    const memberRut = randomRut();
    expect(
      (await call("post", path, await cookieFor(member), body(memberRut)))
        .status,
    ).toBe(403);
    const foreignRut = randomRut();
    expect(
      (
        await call(
          "post",
          path,
          await cookieFor(foreignAdmin),
          body(foreignRut),
        )
      ).status,
    ).toBe(404);
    expect((await countsFor(memberRut)).user).toBe(0);
    expect((await countsFor(foreignRut)).user).toBe(0);

    const platformRut = randomRut();
    expect(
      (await call("post", path, platformCookie, body(platformRut))).status,
    ).toBe(201);
    expect(await countsFor(platformRut)).toMatchObject({
      organizations: 1,
      groups: 1,
    });
  });
});

describe("CR-224 concurrent provisioning of the same RUT", () => {
  it("ends in exactly one 201 and one 409 USER_CONFLICT, never a 500, with one set of rows", async () => {
    const { orgA, groupA1 } = await twoOrganizations();
    const rut = formatRut(randomRut());
    const body = {
      name: "Race Person",
      rut,
      memberships: [
        {
          organizationId: orgA.id,
          role: "USER",
          groups: [{ groupId: groupA1.id }],
        },
      ],
    };

    const responses = await Promise.all([
      call("post", "/admin/users", platformCookie, body),
      call("post", "/admin/users", platformCookie, body),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const conflict = responses.find((response) => response.status === 409)!;
    expect(conflict.body.error.code).toBe("USER_CONFLICT");
    const created = responses.find((response) => response.status === 201)!;
    expect(
      await prisma.user.count({ where: { rut: created.body.user.rut } }),
    ).toBe(1);
    expect(
      await prisma.organizationMembership.count({
        where: { userId: created.body.user.id },
      }),
    ).toBe(1);
    expect(
      await prisma.groupMembership.count({
        where: { userId: created.body.user.id },
      }),
    ).toBe(1);
  });
});
