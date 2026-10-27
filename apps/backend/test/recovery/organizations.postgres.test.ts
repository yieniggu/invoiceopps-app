import { randomInt, randomUUID } from "node:crypto";
import pg from "pg";
import request from "../support/request.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService, hashPassword } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { formatRut } from "../../src/rut.js";

const url = process.env.RECOVERY_TEST_DATABASE_URL;
if (!url) {
  throw new Error("RECOVERY_TEST_DATABASE_URL must be configured");
}
if (new URL(url).pathname !== "/invoiceops_recovery_test") {
  throw new Error(
    "RECOVERY_TEST_DATABASE_URL must target invoiceops_recovery_test",
  );
}

const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const PASSWORD = "correct-horse-battery";

// Single wiring point: the organizations feature must be reachable from the
// same createApp(database, auth) call the other PostgreSQL suites use.
const app = createApp(database, auth);

function randomRut() {
  const body = String(randomInt(10_000_000, 99_999_999));
  let sum = 0;
  let multiplier = 2;
  for (const digit of [...body].reverse()) {
    sum += Number(digit) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const remainder = 11 - (sum % 11);
  const dv =
    remainder === 11 ? "0" : remainder === 10 ? "K" : String(remainder);
  return `${body}${dv}`;
}

async function makeUser(name = "Test User") {
  const rut = randomRut();
  const user = await prisma.user.create({
    data: { name, rut, passwordHash: await hashPassword(PASSWORD) },
    select: { id: true, rut: true },
  });
  return { id: user.id, rut: formatRut(user.rut), rawRut: user.rut };
}
type TestUser = Awaited<ReturnType<typeof makeUser>>;

const makeOrg = (label = "org") =>
  prisma.organization.create({
    data: { name: `Org ${label}`, slug: `${label}-${randomUUID()}` },
  });

const join = (userId: string, organizationId: string, role: "ADMIN" | "USER") =>
  prisma.organizationMembership.create({
    data: { userId, organizationId, role },
  });

async function cookieFor(user: TestUser) {
  const { sessionToken } = await auth.login({
    rut: user.rut,
    password: PASSWORD,
  });
  return `invoiceops_session=${sessionToken}`;
}

function call(
  method: "get" | "post" | "patch" | "delete",
  path: string,
  cookie: string | undefined,
  body?: unknown,
) {
  let test = request(app)[method](`/api/v1${path}`).set(SAME_ORIGIN);
  if (cookie) test = test.set("Cookie", cookie);
  return body === undefined ? test : test.send(body as object);
}

// The PlatformAdministrator singleton cannot be deleted by design (trigger);
// this file owns the singleton of the dedicated test database.
async function designatePlatformAdministrator(userId: string) {
  await client.query("BEGIN");
  try {
    await client.query(
      'ALTER TABLE "PlatformAdministrator" DISABLE TRIGGER prevent_platform_administrator_delete',
    );
    await client.query('DELETE FROM "PlatformAdministrator"');
    await client.query(
      'ALTER TABLE "PlatformAdministrator" ENABLE TRIGGER prevent_platform_administrator_delete',
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  await prisma.platformAdministrator.create({ data: { id: 1, userId } });
}

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

describe("RP0-06 GET /organizations", () => {
  it("lists every organization for the platform administrator and only own ones for others", async () => {
    const [orgA, orgB] = [await makeOrg("a"), await makeOrg("b")];
    const member = await makeUser();
    await join(member.id, orgA.id, "USER");

    const all = await call("get", "/organizations", platformCookie);
    expect(all.status).toBe(200);
    const allIds = (all.body.organizations as Array<{ id: string }>).map(
      (organization) => organization.id,
    );
    expect(allIds).toEqual(expect.arrayContaining([orgA.id, orgB.id]));

    const own = await call("get", "/organizations", await cookieFor(member));
    expect(own.status).toBe(200);
    expect(own.body.organizations).toEqual([
      {
        id: orgA.id,
        name: orgA.name,
        slug: orgA.slug,
        description: null,
        enabled: true,
        createdAt: orgA.createdAt.toISOString(),
      },
    ]);

    const outsider = await call(
      "get",
      "/organizations",
      await cookieFor(await makeUser()),
    );
    expect(outsider.status).toBe(200);
    expect(outsider.body.organizations).toEqual([]);
  });
});

describe("RP0-06 POST /organizations", () => {
  it("creates the organization and its first ADMIN atomically", async () => {
    const firstAdmin = await makeUser();
    const slug = `new-org-${randomUUID()}`;

    const response = await call("post", "/organizations", platformCookie, {
      name: "New Org",
      slug,
      description: "Created by the platform",
      firstAdminRut: firstAdmin.rut,
    });

    expect(response.status).toBe(201);
    expect(response.body.organization).toMatchObject({
      name: "New Org",
      slug,
      description: "Created by the platform",
      enabled: true,
    });
    expect(response.body.membership).toEqual({
      userId: firstAdmin.id,
      organizationId: response.body.organization.id,
      role: "ADMIN",
    });
    const memberships = await prisma.organizationMembership.findMany({
      where: { organizationId: response.body.organization.id },
    });
    expect(memberships.map((m) => [m.userId, m.role])).toEqual([
      [firstAdmin.id, "ADMIN"],
    ]);
  });

  it("does not make the platform administrator an ADMIN unless named explicitly", async () => {
    const firstAdmin = await makeUser();
    const response = await call("post", "/organizations", platformCookie, {
      name: "Not Platform",
      slug: `not-platform-${randomUUID()}`,
      firstAdminRut: firstAdmin.rut,
    });
    expect(response.status).toBe(201);
    expect(
      await prisma.organizationMembership.count({
        where: {
          organizationId: response.body.organization.id,
          userId: platform.id,
        },
      }),
    ).toBe(0);
  });

  it("answers 404 USER_NOT_FOUND and persists no organization for an unknown firstAdminRut", async () => {
    const slug = `rollback-${randomUUID()}`;
    const response = await call("post", "/organizations", platformCookie, {
      name: "Rollback",
      slug,
      firstAdminRut: formatRut(randomRut()),
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("USER_NOT_FOUND");
    expect(await prisma.organization.count({ where: { slug } })).toBe(0);
  });

  it("answers 409 ORGANIZATION_SLUG_CONFLICT for a duplicate slug", async () => {
    const existing = await makeOrg("dup");
    const firstAdmin = await makeUser();
    const response = await call("post", "/organizations", platformCookie, {
      name: "Dup",
      slug: existing.slug,
      firstAdminRut: firstAdmin.rut,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("ORGANIZATION_SLUG_CONFLICT");
    expect(
      await prisma.organizationMembership.count({
        where: { userId: firstAdmin.id },
      }),
    ).toBe(0);
  });

  it("rejects everyone except the platform administrator with 403", async () => {
    const orgAdmin = await makeUser();
    const org = await makeOrg("admin-only");
    await join(orgAdmin.id, org.id, "ADMIN");
    const slug = `forbidden-${randomUUID()}`;

    const response = await call(
      "post",
      "/organizations",
      await cookieFor(orgAdmin),
      { name: "Nope", slug, firstAdminRut: orgAdmin.rut },
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(await prisma.organization.count({ where: { slug } })).toBe(0);
  });

  it.each([
    ["missing firstAdminRut", { name: "X", slug: "x-org" }],
    [
      "unknown field",
      { name: "X", slug: "x-org", firstAdminRut: "1-9", enabled: false },
    ],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_label, body) => {
    const response = await call("post", "/organizations", platformCookie, body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("RP0-08 authority matrix", () => {
  async function scenario() {
    const org = await makeOrg("matrix");
    const admin = await makeUser();
    const member = await makeUser();
    const outsider = await makeUser();
    await join(admin.id, org.id, "ADMIN");
    await join(member.id, org.id, "USER");
    const target = await makeUser();
    await join(target.id, org.id, "USER");
    return { org, admin, member, outsider, target };
  }

  const operations = [
    {
      label: "GET memberships",
      send: (s: Awaited<ReturnType<typeof scenario>>, cookie: string) =>
        call("get", `/organizations/${s.org.id}/memberships`, cookie),
    },
    {
      label: "POST memberships",
      send: (s: Awaited<ReturnType<typeof scenario>>, cookie: string) =>
        call("post", `/organizations/${s.org.id}/memberships`, cookie, {
          rut: formatRut(randomRut()),
          role: "USER",
        }),
    },
    {
      label: "PATCH membership",
      send: (s: Awaited<ReturnType<typeof scenario>>, cookie: string) =>
        call(
          "patch",
          `/organizations/${s.org.id}/memberships/${s.target.id}`,
          cookie,
          { role: "ADMIN" },
        ),
    },
    {
      label: "DELETE membership",
      send: (s: Awaited<ReturnType<typeof scenario>>, cookie: string) =>
        call(
          "delete",
          `/organizations/${s.org.id}/memberships/${s.target.id}`,
          cookie,
        ),
    },
    {
      label: "GET users",
      send: (s: Awaited<ReturnType<typeof scenario>>, cookie: string) =>
        call("get", `/organizations/${s.org.id}/users`, cookie),
    },
    {
      label: "POST users",
      send: (s: Awaited<ReturnType<typeof scenario>>, cookie: string) =>
        call("post", `/organizations/${s.org.id}/users`, cookie, {
          name: "Someone",
          rut: formatRut(randomRut()),
          role: "USER",
        }),
    },
  ];

  it.each(operations)(
    "$label: non-member and platform administrator get 404, USER member gets 403",
    async ({ send }) => {
      const s = await scenario();

      const outsider = await send(s, await cookieFor(s.outsider));
      expect(outsider.status).toBe(404);
      expect(outsider.body.error.code).toBe("NOT_FOUND");

      const platformResponse = await send(s, platformCookie);
      expect(platformResponse.status).toBe(404);
      expect(platformResponse.body.error.code).toBe("NOT_FOUND");

      const member = await send(s, await cookieFor(s.member));
      expect(member.status).toBe(403);
      expect(member.body.error.code).toBe("FORBIDDEN");

      // Nothing was mutated by the rejected calls.
      expect(
        await prisma.organizationMembership.count({
          where: { organizationId: s.org.id },
        }),
      ).toBe(3);
    },
  );
});

describe("RP0-08 memberships", () => {
  it("lists memberships with the user summary for an organization ADMIN", async () => {
    const org = await makeOrg("list");
    const admin = await makeUser("Ada Admin");
    const member = await makeUser("Uma User");
    await join(admin.id, org.id, "ADMIN");
    await join(member.id, org.id, "USER");

    const response = await call(
      "get",
      `/organizations/${org.id}/memberships`,
      await cookieFor(admin),
    );

    expect(response.status).toBe(200);
    expect(response.body.memberships).toHaveLength(2);
    expect(response.body.memberships).toContainEqual({
      userId: member.id,
      organizationId: org.id,
      role: "USER",
      user: { id: member.id, name: "Uma User", rut: member.rawRut },
    });
  });

  it("adds an existing user by RUT without touching credentials", async () => {
    const org = await makeOrg("add");
    const admin = await makeUser();
    await join(admin.id, org.id, "ADMIN");
    const target = await makeUser();
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: target.id },
    });
    const cookie = await cookieFor(admin);

    const created = await call(
      "post",
      `/organizations/${org.id}/memberships`,
      cookie,
      { rut: target.rut, role: "USER" },
    );
    expect(created.status).toBe(201);
    expect(created.body.membership).toEqual({
      userId: target.id,
      organizationId: org.id,
      role: "USER",
    });

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.mustChangePassword).toBe(before.mustChangePassword);
    expect(after.temporaryPasswordExpiresAt).toEqual(
      before.temporaryPasswordExpiresAt,
    );

    const duplicate = await call(
      "post",
      `/organizations/${org.id}/memberships`,
      cookie,
      { rut: target.rut, role: "ADMIN" },
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("MEMBERSHIP_CONFLICT");

    const unknown = await call(
      "post",
      `/organizations/${org.id}/memberships`,
      cookie,
      { rut: formatRut(randomRut()), role: "USER" },
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("USER_NOT_FOUND");

    const extra = await call(
      "post",
      `/organizations/${org.id}/memberships`,
      cookie,
      { rut: target.rut, role: "USER", permissions: ["everything"] },
    );
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("changes a role, removes a member and protects the last ADMIN", async () => {
    const org = await makeOrg("roles");
    const admin = await makeUser();
    const other = await makeUser();
    await join(admin.id, org.id, "ADMIN");
    await join(other.id, org.id, "USER");
    const cookie = await cookieFor(admin);
    const path = (userId: string) =>
      `/organizations/${org.id}/memberships/${userId}`;

    const lastAdminDemotion = await call("patch", path(admin.id), cookie, {
      role: "USER",
    });
    expect(lastAdminDemotion.status).toBe(409);
    expect(lastAdminDemotion.body.error.code).toBe("LAST_ADMIN_REQUIRED");
    const lastAdminRemoval = await call("delete", path(admin.id), cookie);
    expect(lastAdminRemoval.status).toBe(409);
    expect(lastAdminRemoval.body.error.code).toBe("LAST_ADMIN_REQUIRED");

    const promoted = await call("patch", path(other.id), cookie, {
      role: "ADMIN",
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.membership).toEqual({
      userId: other.id,
      organizationId: org.id,
      role: "ADMIN",
    });

    const demoted = await call("patch", path(admin.id), cookie, {
      role: "USER",
    });
    expect(demoted.status).toBe(200);
    expect(demoted.body.membership.role).toBe("USER");

    const extra = await call("patch", path(other.id), cookie, {
      role: "USER",
      userId: "x",
    });
    expect(extra.status).toBe(400);
  });

  it("removes only the group memberships of that organization", async () => {
    const [orgA, orgB] = [await makeOrg("rm-a"), await makeOrg("rm-b")];
    const admin = await makeUser();
    const target = await makeUser();
    await join(admin.id, orgA.id, "ADMIN");
    await join(target.id, orgA.id, "USER");
    await join(target.id, orgB.id, "USER");
    const groupA = await prisma.group.create({
      data: { organizationId: orgA.id, name: "GA" },
    });
    const groupB = await prisma.group.create({
      data: { organizationId: orgB.id, name: "GB" },
    });
    for (const group of [groupA, groupB]) {
      await prisma.groupMembership.create({
        data: {
          groupId: group.id,
          userId: target.id,
          organizationId: group.organizationId,
        },
      });
    }

    const response = await call(
      "delete",
      `/organizations/${orgA.id}/memberships/${target.id}`,
      await cookieFor(admin),
    );

    expect(response.status).toBe(204);
    expect(
      await prisma.organizationMembership.count({
        where: { userId: target.id, organizationId: orgA.id },
      }),
    ).toBe(0);
    expect(
      await prisma.groupMembership.count({
        where: { userId: target.id, organizationId: orgA.id },
      }),
    ).toBe(0);
    expect(
      await prisma.organizationMembership.count({
        where: { userId: target.id, organizationId: orgB.id },
      }),
    ).toBe(1);
    expect(
      await prisma.groupMembership.count({
        where: { userId: target.id, organizationId: orgB.id },
      }),
    ).toBe(1);
  });
});

describe("RP0-08 organization users", () => {
  it("provisions a user atomically with a no-store temporary password that logs in", async () => {
    const org = await makeOrg("provision");
    const admin = await makeUser();
    await join(admin.id, org.id, "ADMIN");
    const rut = formatRut(randomRut());

    const response = await call(
      "post",
      `/organizations/${org.id}/users`,
      await cookieFor(admin),
      { name: "New Person", rut, role: "USER" },
    );

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expect(response.body.user).toMatchObject({
      name: "New Person",
      rut: expect.any(String),
      mustChangePassword: true,
    });
    expect(response.body.membership).toEqual({
      userId: response.body.user.id,
      organizationId: org.id,
      role: "USER",
    });
    expect(typeof response.body.temporaryPassword).toBe("string");
    expect(response.body.temporaryPassword.length).toBeGreaterThan(0);

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ rut, password: response.body.temporaryPassword });
    expect(login.status).toBe(200);
    const profile = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", String(login.headers["set-cookie"]).split(";")[0]);
    expect(profile.status).toBe(200);
    expect(profile.body.profile.mustChangePassword).toBe(true);
  });

  it("answers 409 USER_CONFLICT for a duplicate RUT and leaves nothing behind", async () => {
    const org = await makeOrg("dup-user");
    const admin = await makeUser();
    const existing = await makeUser();
    await join(admin.id, org.id, "ADMIN");
    const membershipsBefore = await prisma.organizationMembership.count({
      where: { organizationId: org.id },
    });

    const response = await call(
      "post",
      `/organizations/${org.id}/users`,
      await cookieFor(admin),
      { name: "Clone", rut: existing.rut, role: "ADMIN" },
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("USER_CONFLICT");
    expect(await prisma.user.count({ where: { rut: existing.rawRut } })).toBe(
      1,
    );
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: org.id },
      }),
    ).toBe(membershipsBefore);
  });

  it("lists only the members of that organization", async () => {
    const [orgA, orgB] = [await makeOrg("u-a"), await makeOrg("u-b")];
    const admin = await makeUser("Ada Admin");
    const member = await makeUser("Uma User");
    const foreign = await makeUser("Fiona Foreign");
    await join(admin.id, orgA.id, "ADMIN");
    await join(member.id, orgA.id, "USER");
    await join(foreign.id, orgB.id, "USER");

    const response = await call(
      "get",
      `/organizations/${orgA.id}/users`,
      await cookieFor(admin),
    );

    expect(response.status).toBe(200);
    expect(response.body.users).toHaveLength(2);
    expect(response.body.users).toContainEqual({
      id: member.id,
      name: "Uma User",
      rut: member.rawRut,
      role: "USER",
    });
    expect(
      (response.body.users as Array<{ id: string }>).map((user) => user.id),
    ).not.toContain(foreign.id);
  });
});
