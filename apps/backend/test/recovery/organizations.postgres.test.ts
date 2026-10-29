import { randomInt, randomUUID } from "node:crypto";
import pg from "pg";
import request from "../support/request.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService, hashPassword } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { formatRut } from "../../src/rut.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

const url = recoveryTestDatabaseUrl();

const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const PASSWORD = "correct-horse-battery";
const NO_FLAGS = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};
const MISSING_ORG = "00000000-0000-4000-8000-000000000000";

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
  method: "get" | "post" | "patch" | "put" | "delete",
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

    const all = await call(
      "get",
      "/organizations?pageSize=100&search=Org",
      platformCookie,
    );
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ page: 1, pageSize: 100 });
    expect(all.body.total).toBeGreaterThanOrEqual(2);
    // Control: the unfiltered platform list is paginated too.
    const unfiltered = await call("get", "/organizations", platformCookie);
    expect(unfiltered.body.organizations.length).toBeLessThanOrEqual(20);
    expect(unfiltered.body.total).toBeGreaterThanOrEqual(all.body.total);
    const byName = await call(
      "get",
      `/organizations?search=${encodeURIComponent(orgA.name)}`,
      platformCookie,
    );
    const allIds = (byName.body.organizations as Array<{ id: string }>).map(
      (organization) => organization.id,
    );
    expect(allIds).toContain(orgA.id);
    expect(allIds).not.toContain(orgB.id);

    const own = await call("get", "/organizations", await cookieFor(member));
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ page: 1, pageSize: 20, total: 1 });
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
    expect(outsider.body).toMatchObject({ organizations: [], total: 0 });
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
      permissions: NO_FLAGS,
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
    const newcomer = await makeUser();
    await join(admin.id, org.id, "ADMIN");
    await join(member.id, org.id, "USER");
    const target = await makeUser();
    await join(target.id, org.id, "USER");
    return { org, admin, member, outsider, newcomer, target };
  }
  type S = Awaited<ReturnType<typeof scenario>>;

  // `platformStatus` is the outcome for the platform administrator over an
  // existing organization: administrative authority without membership.
  const operations = [
    {
      label: "GET memberships",
      platformStatus: 200,
      send: (s: S, cookie: string, orgId = s.org.id) =>
        call("get", `/organizations/${orgId}/memberships`, cookie),
    },
    {
      label: "POST memberships",
      platformStatus: 201,
      send: (s: S, cookie: string, orgId = s.org.id) =>
        call("post", `/organizations/${orgId}/memberships`, cookie, {
          rut: s.newcomer.rut,
          role: "USER",
        }),
    },
    {
      label: "PATCH membership",
      platformStatus: 200,
      send: (s: S, cookie: string, orgId = s.org.id) =>
        call(
          "patch",
          `/organizations/${orgId}/memberships/${s.target.id}`,
          cookie,
          { role: "ADMIN" },
        ),
    },
    {
      label: "PUT membership permissions",
      platformStatus: 200,
      send: (s: S, cookie: string, orgId = s.org.id) =>
        call(
          "put",
          `/organizations/${orgId}/memberships/${s.target.id}/permissions`,
          cookie,
          { permissions: NO_FLAGS },
        ),
    },
    {
      label: "DELETE membership",
      platformStatus: 204,
      send: (s: S, cookie: string, orgId = s.org.id) =>
        call(
          "delete",
          `/organizations/${orgId}/memberships/${s.target.id}`,
          cookie,
        ),
    },
    {
      label: "GET users",
      platformStatus: 200,
      send: (s: S, cookie: string, orgId = s.org.id) =>
        call("get", `/organizations/${orgId}/users`, cookie),
    },
    {
      label: "POST users",
      platformStatus: 201,
      send: (s: S, cookie: string, orgId = s.org.id) =>
        call("post", `/organizations/${orgId}/users`, cookie, {
          name: "Someone",
          rut: formatRut(randomRut()),
          role: "USER",
        }),
    },
  ];

  it.each(operations)(
    "$label: non-member gets 404 and USER member gets 403 without mutations",
    async ({ send }) => {
      const s = await scenario();

      const outsider = await send(s, await cookieFor(s.outsider));
      expect(outsider.status).toBe(404);
      expect(outsider.body.error.code).toBe("NOT_FOUND");

      const member = await send(s, await cookieFor(s.member));
      expect(member.status).toBe(403);
      expect(member.body.error.code).toBe("FORBIDDEN");

      expect(
        await prisma.organizationMembership.count({
          where: { organizationId: s.org.id },
        }),
      ).toBe(3);
    },
  );

  it.each(operations)(
    "$label: the platform administrator is allowed over an existing organization and gets 404 over a missing one",
    async ({ send, platformStatus }) => {
      const s = await scenario();

      const missing = await send(s, platformCookie, MISSING_ORG);
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe("NOT_FOUND");

      const allowed = await send(s, platformCookie);
      expect(allowed.status).toBe(platformStatus);
    },
  );

  it("gives the platform administrator no membership from administering", async () => {
    const s = await scenario();
    await call("get", `/organizations/${s.org.id}/memberships`, platformCookie);
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: s.org.id, userId: platform.id },
      }),
    ).toBe(0);
  });
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
      permissions: NO_FLAGS,
      groups: [],
      user: {
        id: member.id,
        name: "Uma User",
        rut: member.rawRut,
        disabled: false,
        recentlyActive: false,
      },
    });
    expect(response.body).toMatchObject({ page: 1, pageSize: 20, total: 2 });
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
      permissions: NO_FLAGS,
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
      permissions: NO_FLAGS,
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
      permissions: NO_FLAGS,
    });
    expect(response.body.groups).toEqual([]);
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

  it("accepts an admin-defined temporary password without echoing it", async () => {
    const org = await makeOrg("defined-pass");
    const admin = await makeUser();
    await join(admin.id, org.id, "ADMIN");
    const rut = formatRut(randomRut());
    const defined = "Defined-temp-pass-78";

    const response = await call(
      "post",
      `/organizations/${org.id}/users`,
      await cookieFor(admin),
      { name: "Defined", rut, role: "USER", temporaryPassword: defined },
    );

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expect(response.body).not.toHaveProperty("temporaryPassword");
    expect(JSON.stringify(response.body)).not.toContain(defined);
    const audit = await prisma.platformAdministrativeAuditEvent.findMany({
      where: { targetUserId: response.body.user.id },
    });
    expect(JSON.stringify(audit)).not.toContain(defined);
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ rut, password: defined });
    expect(login.status).toBe(200);
    const profile = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", String(login.headers["set-cookie"]).split(";")[0]);
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
    expect(response.body).toMatchObject({ page: 1, pageSize: 20, total: 2 });
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

  it("searches the users of an organization by name or RUT, escaping LIKE wildcards", async () => {
    const [org, other] = [await makeOrg("u-search"), await makeOrg("u-other")];
    const admin = await makeUser("Aaa Admin");
    const ana = await makeUser("Ana Pérez");
    const percent = await makeUser("Cien% Real");
    const underscore = await makeUser("Guion_Bajo");
    const foreign = await makeUser("Ana Foreign");
    for (const user of [admin, ana, percent, underscore])
      await join(user.id, org.id, user === admin ? "ADMIN" : "USER");
    await join(foreign.id, other.id, "USER");
    const cookie = await cookieFor(admin);
    const path = `/organizations/${org.id}/users`;
    const names = (r: { body: { users: Array<{ name: string }> } }) =>
      r.body.users.map((u) => u.name);

    // Case-insensitive fragment of the name, only this organization.
    const byName = await call("get", `${path}?search=ANA`, cookie);
    expect(byName.status).toBe(200);
    expect(names(byName)).toEqual(["Ana Pérez"]);
    expect(byName.body.total).toBe(1);

    // RUT fragment typed with dots and hyphen, like the admin directory.
    const formatted = formatRut(ana.rawRut);
    const byRut = await call(
      "get",
      `${path}?search=${encodeURIComponent(formatted)}`,
      cookie,
    );
    expect(names(byRut)).toEqual(["Ana Pérez"]);
    const partialRut = await call(
      "get",
      `${path}?search=${encodeURIComponent(ana.rawRut.slice(0, 5))}`,
      cookie,
    );
    expect(names(partialRut)).toContain("Ana Pérez");

    // LIKE wildcards are literal.
    expect(names(await call("get", `${path}?search=%25`, cookie))).toEqual([
      "Cien% Real",
    ]);
    expect(names(await call("get", `${path}?search=_`, cookie))).toEqual([
      "Guion_Bajo",
    ]);
    // Punctuation alone has no RUT part: it must not select everybody.
    expect(
      names(
        await call("get", `${path}?search=${encodeURIComponent("-")}`, cookie),
      ),
    ).toEqual([]);

    // total and paging follow the filter.
    const paged = await call(
      "get",
      `${path}?search=a&page=1&pageSize=1`,
      cookie,
    );
    expect(paged.body.users).toHaveLength(1);
    expect(paged.body.total).toBeGreaterThan(1);
    const none = await call("get", `${path}?search=zzzz`, cookie);
    expect(none.body).toMatchObject({ users: [], total: 0 });
    // A search never widens access.
    expect(
      (await call("get", `${path}?search=ana`, await cookieFor(ana))).status,
    ).toBe(403);
  });

  it("paginates users by name with a consistent total and bounds", async () => {
    const org = await makeOrg("u-page");
    const admin = await makeUser("Aaa Admin");
    const twins = [await makeUser("Bob One"), await makeUser("Bob Two")];
    const zed = await makeUser("Zed Last");
    for (const user of [admin, ...twins, zed]) {
      await join(user.id, org.id, user === admin ? "ADMIN" : "USER");
    }
    const cookie = await cookieFor(admin);
    const path = `/organizations/${org.id}/users`;
    const expected = [admin.id, ...twins.map((t) => t.id), zed.id];

    const pages = [
      await call("get", `${path}?page=1&pageSize=2`, cookie),
      await call("get", `${path}?page=2&pageSize=2`, cookie),
      await call("get", `${path}?page=3&pageSize=2`, cookie),
    ];
    const ids = (r: { body: { users: Array<{ id: string }> } }) =>
      r.body.users.map((u) => u.id);

    expect(pages.map((p) => p.body.total)).toEqual([4, 4, 4]);
    expect(pages[1]!.body).toMatchObject({ page: 2, pageSize: 2 });
    expect([...ids(pages[0]!), ...ids(pages[1]!)]).toEqual(expected);
    expect(ids(pages[2]!)).toEqual([]);
    expect((await call("get", `${path}?pageSize=100`, cookie)).status).toBe(
      200,
    );
    for (const bad of ["pageSize=101", "page=0", "page=10001", "foo=1"]) {
      expect((await call("get", `${path}?${bad}`, cookie)).status).toBe(400);
    }
  });
});
