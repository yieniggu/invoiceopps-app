import { randomUUID } from "node:crypto";
import pg from "pg";
import request from "../support/request.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { formatRut } from "../../src/rut.js";
import {
  membershipFixtures,
  NO_FLAGS,
  PASSWORD,
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
  makeGroup,
  addToGroup,
  join,
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

// Prisma stores DateTime as UTC wall-clock time in a timestamp column, while
// node-postgres would read and write it in the host time zone. Computing in SQL
// against UTC keeps the tests independent of the host TZ.
const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;

const token = () => randomUUID().replaceAll("-", "").slice(0, 10);

const listUsers = (query: string, cookie: string | null = platformCookie) =>
  call("get", `/admin/users${query}`, cookie ?? undefined);
const getUser = (userId: string, cookie: string | null = platformCookie) =>
  call("get", `/admin/users/${userId}`, cookie ?? undefined);
const patchUser = (
  userId: string,
  body: unknown,
  cookie: string | null = platformCookie,
) => call("patch", `/admin/users/${userId}`, cookie ?? undefined, body);
const resetPassword = (
  userId: string,
  body: unknown = {},
  cookie: string | null = platformCookie,
) =>
  call(
    "post",
    `/admin/users/${userId}/password-reset`,
    cookie ?? undefined,
    body,
  );

async function setLastActive(userId: string, minutesAgo: number | null) {
  if (minutesAgo === null) {
    await client.query(
      `UPDATE "User" SET "lastActiveAt" = NULL WHERE id = $1`,
      [userId],
    );
    return;
  }
  await client.query(
    `UPDATE "User" SET "lastActiveAt" = ${UTC_NOW} - make_interval(mins => $2)
     WHERE id = $1`,
    [userId, minutesAgo],
  );
}

async function disableDirectly(userId: string) {
  await client.query(
    `UPDATE "User" SET "disabledAt" = ${UTC_NOW} WHERE id = $1`,
    [userId],
  );
}

async function sessionCount(userId: string) {
  const result = await client.query(
    'SELECT count(*)::int AS n FROM "Session" WHERE "userId" = $1',
    [userId],
  );
  return result.rows[0].n as number;
}

async function auditRows(type: string, targetUserId: string) {
  const result = await client.query(
    `SELECT type::text AS type, "actorUserId", "targetUserId", "organizationId",
            "groupId", "actorIsTarget", role::text AS role,
            "previousRole"::text AS "previousRole"
     FROM "PlatformAdministrativeAuditEvent"
     WHERE type::text = $1 AND "targetUserId" = $2`,
    [type, targetUserId],
  );
  return result.rows;
}

async function seedToken(userId: string, organizationId: string) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "ApiToken" ("id","userId","name","organizationId","tokenHash","scopes","expiresAt")
     VALUES ($1,$2,'t',$3,$4,ARRAY['invoices:read']::"ApiTokenScope"[],${UTC_NOW} + interval '1 day')`,
    [id, userId, organizationId, `hash-${id}`],
  );
  return id;
}

async function revokedAt(tokenId: string) {
  const result = await client.query(
    'SELECT "revokedAt"::text AS value FROM "ApiToken" WHERE id = $1',
    [tokenId],
  );
  return result.rows[0].value as string | null;
}

async function storedUser(userId: string) {
  const result = await client.query(
    `SELECT name, rut, "mustChangePassword",
            "disabledAt"::text AS "disabledAt",
            to_char("temporaryPasswordExpiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt",
            "passwordHash"
     FROM "User" WHERE id = $1`,
    [userId],
  );
  return result.rows[0] as {
    name: string;
    rut: string;
    mustChangePassword: boolean;
    disabledAt: string | null;
    expiresAt: string | null;
    passwordHash: string;
  };
}

async function memberWithSecrets(label: string) {
  const org = await makeOrg(label);
  const user = await makeUser(`Member ${label}`);
  await join(user.id, org.id, "USER");
  const cookie = await cookieFor(user);
  const apiToken = await seedToken(user.id, org.id);
  return { org, user, cookie, apiToken };
}

async function orgAdminAndUser(label: string) {
  const org = await makeOrg(label);
  const admin = await makeUser(`Admin ${label}`);
  const plain = await makeUser(`Plain ${label}`);
  await join(admin.id, org.id, "ADMIN");
  await join(plain.id, org.id, "USER");
  return {
    adminCookie: await cookieFor(admin),
    plainCookie: await cookieFor(plain),
  };
}

describe("AC-01 GET /api/v1/admin/users authority and validation", () => {
  it("answers 200 to the platform administrator (control) and 401/403 to everyone else", async () => {
    const { adminCookie, plainCookie } = await orgAdminAndUser("ac01-authz");
    const outsider = await makeUser("Outsider");

    const ok = await listUsers("?pageSize=1");
    const anonymous = await listUsers("", null);
    const orgAdmin = await listUsers("", adminCookie);
    const orgUser = await listUsers("", plainCookie);
    const noMembership = await listUsers("", await cookieFor(outsider));

    expect(ok.status).toBe(200);
    expect(anonymous.status).toBe(401);
    for (const response of [orgAdmin, orgUser, noMembership]) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
  });

  it("answers 403 ONBOARDING_REQUIRED while the platform administrator still has a temporary password", async () => {
    await client.query(
      `UPDATE "User" SET "mustChangePassword" = true,
         "temporaryPasswordExpiresAt" = ${UTC_NOW} + interval '1 hour'
       WHERE id = $1`,
      [platform.id],
    );
    try {
      const response = await listUsers("");
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("ONBOARDING_REQUIRED");
    } finally {
      await client.query(
        `UPDATE "User" SET "mustChangePassword" = false,
           "temporaryPasswordExpiresAt" = NULL WHERE id = $1`,
        [platform.id],
      );
    }
    // Control: the route exists and answers 200 once onboarding is complete.
    expect((await listUsers("?pageSize=1")).status).toBe(200);
  });

  it.each([
    ["unknown parameter", "?foo=1"],
    ["empty search", "?search="],
    ["blank search", "?search=%20%20"],
    ["search of 121 characters", `?search=${"x".repeat(121)}`],
    ["repeated parameter", "?search=a&search=b"],
    ["unknown status", "?status=bogus"],
    ["page 0", "?page=0"],
    ["pageSize 0", "?pageSize=0"],
    ["pageSize 101", "?pageSize=101"],
    ["non numeric pageSize", "?pageSize=abc"],
  ])("rejects %s with 400 VALIDATION_ERROR", async (_label, query) => {
    const control = await listUsers("?pageSize=1");
    const response = await listUsers(query);
    expect(control.status).toBe(200);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("validates the query before the authority", async () => {
    const { adminCookie } = await orgAdminAndUser("ac01-order");
    expect((await listUsers("?foo=1", adminCookie)).status).toBe(400);
  });
});

describe("AC-01 GET /api/v1/admin/users directory", () => {
  it("returns {users,page,pageSize,total} with exactly the documented item keys", async () => {
    const key = token();
    const user = await makeUser(`Shape ${key}`);

    const response = await listUsers(`?search=${key}`);

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual([
      "page",
      "pageSize",
      "total",
      "users",
    ]);
    expect(response.body).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    expect(response.body.users).toEqual([
      {
        id: user.id,
        name: `Shape ${key}`,
        rut: user.rut,
        disabledAt: null,
        recentlyActive: expect.any(Boolean),
      },
    ]);
    expect(JSON.stringify(response.body)).not.toContain("lastActiveAt");
  });

  it("includes the platform administrator and disabled users", async () => {
    const key = token();
    const disabled = await makeUser(`Disabled ${key}`);
    await disableDirectly(disabled.id);

    const found = await listUsers(`?search=${key}`);
    const admin = await listUsers("?search=Platform%20Administrator");

    expect(found.body.users.map((u: { id: string }) => u.id)).toEqual([
      disabled.id,
    ]);
    expect(found.body.users[0].disabledAt).toMatch(/Z$/);
    expect(admin.body.users.map((u: { id: string }) => u.id)).toContain(
      platform.id,
    );
  });

  it("searches names case-insensitively by substring", async () => {
    const key = token();
    const user = await makeUser(`Maria ${key} Perez`);
    await makeUser(`Other ${token()}`);

    for (const term of [
      key.toUpperCase(),
      `maria ${key.slice(0, 4)}`.toUpperCase(),
      `  ${key}  `,
    ]) {
      const response = await listUsers(`?search=${encodeURIComponent(term)}`);
      expect(response.body.users.map((u: { id: string }) => u.id)).toEqual([
        user.id,
      ]);
    }
  });

  it("finds a user by a RUT fragment typed with dots and hyphen", async () => {
    const user = await makeUser(`Rut ${token()}`);
    const formatted = user.rut; // 12.345.678-5
    const body = formatted.slice(0, -2); // 12.345.678
    const fragments = [
      formatted,
      body,
      formatted.slice(-5), // 678-5
      user.rawRut,
      formatted.slice(2, 9),
    ];
    for (const term of fragments) {
      const response = await listUsers(`?search=${encodeURIComponent(term)}`);
      expect(response.status).toBe(200);
      expect(
        response.body.users.map((u: { id: string }) => u.id),
        `search ${term}`,
      ).toContain(user.id);
    }
    const exact = await listUsers(`?search=${encodeURIComponent(formatted)}`);
    expect(exact.body.users.map((u: { id: string }) => u.id)).toEqual([
      user.id,
    ]);
  });

  it("matches a lowercase k against the uppercase verifier digit", async () => {
    let rut = randomRut();
    while (!rut.endsWith("K")) rut = randomRut();
    const created = await prisma.user.create({
      data: { name: `Kay ${token()}`, rut, passwordHash: "x" },
      select: { id: true, rut: true },
    });
    const formatted = formatRut(created.rut);
    const lower = formatted.slice(-5).toLowerCase();
    expect(lower.endsWith("k")).toBe(true);

    const response = await listUsers(`?search=${encodeURIComponent(lower)}`);

    expect(response.body.users.map((u: { id: string }) => u.id)).toContain(
      created.id,
    );
  });

  it("matches a search made only of punctuation against names alone", async () => {
    const expected = await client.query(
      `SELECT count(*)::int AS n FROM "User" WHERE name ILIKE '%.%'`,
    );
    const response = await listUsers(`?search=${encodeURIComponent(".")}`);
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(expected.rows[0].n);
  });

  it("treats % and _ in the search as literal characters", async () => {
    const key = token();
    await makeUser(`Wild ${key} 100% sure`);
    await makeUser(`Wild ${key} under_score`);
    await makeUser(`Wild ${key} plain`);

    for (const [term, needle] of [
      ["%", "%"],
      ["_", "_"],
    ] as const) {
      const expected = await client.query(
        `SELECT count(*)::int AS n FROM "User" WHERE position($1 in name) > 0`,
        [needle],
      );
      const response = await listUsers(`?search=${encodeURIComponent(term)}`);
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(expected.rows[0].n);
    }
    const scoped = await listUsers(
      `?search=${encodeURIComponent(`${key} 100%`)}`,
    );
    expect(scoped.body.total).toBe(1);
  });

  it("filters by status", async () => {
    const key = token();
    const enabled = await makeUser(`Status ${key} on`);
    const disabled = await makeUser(`Status ${key} off`);
    await disableDirectly(disabled.id);
    const ids = (response: { body: { users: Array<{ id: string }> } }) =>
      response.body.users.map((u) => u.id).sort();

    const all = await listUsers(`?search=${key}`);
    const explicitAll = await listUsers(`?search=${key}&status=all`);
    const active = await listUsers(`?search=${key}&status=active`);
    const off = await listUsers(`?search=${key}&status=disabled`);

    expect(ids(all)).toEqual([enabled.id, disabled.id].sort());
    expect(ids(explicitAll)).toEqual(ids(all));
    expect(ids(active)).toEqual([enabled.id]);
    expect(ids(off)).toEqual([disabled.id]);
    expect(active.body.total).toBe(1);
    expect(off.body.total).toBe(1);
  });

  it("paginates with a consistent total, name order and id tie-break", async () => {
    const key = token();
    const a = await makeUser(`Page ${key} A`);
    const b = await makeUser(`Page ${key} B`);
    const c1 = await makeUser(`Page ${key} C`);
    const c2 = await makeUser(`Page ${key} C`);
    const d = await makeUser(`Page ${key} D`);
    const [c1First, c2First] = [c1.id, c2.id].sort();
    const expected = [a.id, b.id, c1First, c2First, d.id];

    const page1 = await listUsers(`?search=${key}&pageSize=2`);
    const page2 = await listUsers(`?search=${key}&pageSize=2&page=2`);
    const page3 = await listUsers(`?search=${key}&pageSize=2&page=3`);
    const page4 = await listUsers(`?search=${key}&pageSize=2&page=4`);

    for (const page of [page1, page2, page3, page4]) {
      expect(page.status).toBe(200);
      expect(page.body.total).toBe(5);
      expect(page.body.pageSize).toBe(2);
    }
    expect(page1.body.page).toBe(1);
    expect(page4.body.page).toBe(4);
    const ids = (page: { body: { users: Array<{ id: string }> } }) =>
      page.body.users.map((u) => u.id);
    expect([...ids(page1), ...ids(page2), ...ids(page3)]).toEqual(expected);
    expect(ids(page3)).toHaveLength(1);
    expect(ids(page4)).toEqual([]);
  });

  it("reports recentlyActive from lastActiveAt inside the window", async () => {
    const key = token();
    const fresh = await makeUser(`Active ${key} fresh`);
    const stale = await makeUser(`Active ${key} stale`);
    const never = await makeUser(`Active ${key} never`);
    await setLastActive(fresh.id, 1);
    await setLastActive(stale.id, 20);
    await setLastActive(never.id, null);

    const response = await listUsers(`?search=${key}`);

    const byId = new Map(
      response.body.users.map((u: { id: string; recentlyActive: boolean }) => [
        u.id,
        u.recentlyActive,
      ]),
    );
    expect(byId.get(fresh.id)).toBe(true);
    expect(byId.get(stale.id)).toBe(false);
    expect(byId.get(never.id)).toBe(false);
  });

  it("reports recentlyActive false for a disabled user on list, detail and PATCH", async () => {
    const key = token();
    const user = await makeUser(`Active ${key} disabled`);
    await setLastActive(user.id, 1);
    await disableDirectly(user.id);

    const list = await listUsers(`?search=${key}`);
    const detail = await getUser(user.id);
    const patched = await patchUser(user.id, { name: `Active ${key} renamed` });

    expect(list.body.users).toHaveLength(1);
    expect(list.body.users[0].recentlyActive).toBe(false);
    expect(detail.body.user.recentlyActive).toBe(false);
    expect(patched.status).toBe(200);
    expect(patched.body.user.recentlyActive).toBe(false);
  });
});

describe("AC-02 GET /api/v1/admin/users/{userId}", () => {
  it("answers 401/403 outside the platform administrator, with a 200 control", async () => {
    const { adminCookie, plainCookie } = await orgAdminAndUser("ac02-authz");
    const target = await makeUser("Detail Target");

    expect((await getUser(target.id)).status).toBe(200);
    expect((await getUser(target.id, null)).status).toBe(401);
    expect((await getUser(target.id, adminCookie)).status).toBe(403);
    expect((await getUser(target.id, plainCookie)).status).toBe(403);
  });

  it("answers 404 NOT_FOUND for an unknown user", async () => {
    const control = await makeUser("Detail Control");
    expect((await getUser(control.id)).status).toBe(200);

    const missing = await getUser(randomUUID());

    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  it("returns the user, memberships ordered by organization and groups ordered by name", async () => {
    const orgB = await prisma.organization.create({
      data: { name: "Zeta Detail", slug: `zeta-${randomUUID()}` },
    });
    const orgA = await prisma.organization.create({
      data: { name: "Alpha Detail", slug: `alpha-${randomUUID()}` },
    });
    const target = await makeUser("Detail Shape");
    await join(target.id, orgB.id, "USER");
    await join(target.id, orgA.id, "ADMIN", {
      readInvoices: true,
      deleteOthersInvoices: true,
    });
    const g2 = await makeGroup(orgA.id, "Beta group");
    const g1 = await makeGroup(orgA.id, "Alpha group");
    await addToGroup(g2.id, target.id, orgA.id, { createInvoices: true });
    await addToGroup(g1.id, target.id, orgA.id);
    await setLastActive(target.id, 1);

    const response = await getUser(target.id);

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(["memberships", "user"]);
    expect(response.body.user).toEqual({
      id: target.id,
      name: "Detail Shape",
      rut: target.rut,
      email: null,
      disabledAt: null,
      mustChangePassword: false,
      recentlyActive: true,
      isPlatformAdministrator: false,
    });
    expect(response.body.memberships).toEqual([
      {
        organization: { id: orgA.id, name: "Alpha Detail", slug: orgA.slug },
        role: "ADMIN",
        permissions: {
          ...NO_FLAGS,
          readInvoices: true,
          deleteOthersInvoices: true,
        },
        groups: [
          { group: { id: g1.id, name: "Alpha group" }, permissions: NO_FLAGS },
          {
            group: { id: g2.id, name: "Beta group" },
            permissions: { ...NO_FLAGS, createInvoices: true },
          },
        ],
      },
      {
        organization: { id: orgB.id, name: "Zeta Detail", slug: orgB.slug },
        role: "USER",
        permissions: NO_FLAGS,
        groups: [],
      },
    ]);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("scrypt");
    expect(serialized).not.toContain("lastActiveAt");
  });

  it("reports disabledAt, mustChangePassword and the platform administrator flag", async () => {
    const target = await makeUser("Detail Flags");
    await disableDirectly(target.id);
    await client.query(
      `UPDATE "User" SET "mustChangePassword" = true, email = 'a@example.com'
       WHERE id = $1`,
      [target.id],
    );

    const response = await getUser(target.id);
    const admin = await getUser(platform.id);

    expect(response.body.user).toMatchObject({
      disabledAt: expect.stringMatching(/Z$/),
      mustChangePassword: true,
      email: "a@example.com",
      isPlatformAdministrator: false,
    });
    expect(admin.body.user.isPlatformAdministrator).toBe(true);
  });
});

describe("AC-03 PATCH /api/v1/admin/users/{userId}", () => {
  it("answers 401/403/404 with a 200 control", async () => {
    const { adminCookie, plainCookie } = await orgAdminAndUser("ac03-authz");
    const target = await makeUser("Patch Target");

    expect((await patchUser(target.id, { name: "Patch Control" })).status).toBe(
      200,
    );
    expect((await patchUser(target.id, { name: "X" }, null)).status).toBe(401);
    for (const cookie of [adminCookie, plainCookie]) {
      const forbidden = await patchUser(target.id, { name: "X" }, cookie);
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.error.code).toBe("FORBIDDEN");
    }
    const missing = await patchUser(randomUUID(), { name: "X" });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
    expect((await storedUser(target.id)).name).toBe("Patch Control");
  });

  it("rejects a cross-origin write", async () => {
    const target = await makeUser("Patch Csrf");
    const response = await request(app)
      .patch(`/api/v1/admin/users/${target.id}`)
      .set({ Host: "127.0.0.1", Origin: "http://evil.example" })
      .set("Cookie", platformCookie)
      .send({ name: "Hacked" });
    expect(response.status).toBe(403);
    expect((await storedUser(target.id)).name).toBe("Patch Csrf");
    // Control: the same write from the same origin goes through.
    expect((await patchUser(target.id, { name: "Patch Csrf 2" })).status).toBe(
      200,
    );
  });

  it.each([
    ["empty object", {}],
    ["unknown field", { name: "Grace", email: "a@b.c" }],
    ["blank name", { name: "   " }],
    ["name of 121", { name: "x".repeat(121) }],
    ["invalid RUT", { rut: "11.111.111-2" }],
    ["numeric RUT", { rut: 123456785 }],
  ])("rejects %s with 400 and changes nothing", async (_label, body) => {
    const target = await makeUser("Patch Validation");
    const before = await storedUser(target.id);

    const response = await patchUser(target.id, body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(await storedUser(target.id)).toEqual(before);
    expect(await auditRows("USER_UPDATED", target.id)).toEqual([]);
  });

  it("changes the name, keeps sessions and tokens and audits with ids only", async () => {
    const { user, cookie, apiToken } = await memberWithSecrets("ac03-name");

    const response = await patchUser(user.id, { name: "  Renamed User  " });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      user: {
        id: user.id,
        name: "Renamed User",
        rut: user.rut,
        email: null,
        disabledAt: null,
        mustChangePassword: false,
        recentlyActive: expect.any(Boolean),
        isPlatformAdministrator: false,
      },
    });
    expect((await storedUser(user.id)).name).toBe("Renamed User");
    expect((await call("get", "/auth/profile", cookie)).status).toBe(200);
    expect(await revokedAt(apiToken)).toBeNull();
    expect(await auditRows("USER_UPDATED", user.id)).toEqual([
      {
        type: "USER_UPDATED",
        actorUserId: platform.id,
        targetUserId: user.id,
        organizationId: null,
        groupId: null,
        actorIsTarget: false,
        role: null,
        previousRole: null,
      },
    ]);
  });

  it("changes the RUT, revokes sessions and tokens, and the new RUT logs in", async () => {
    const { org, user, cookie, apiToken } = await memberWithSecrets("ac03-rut");
    await cookieFor(user);
    const alreadyRevoked = await seedToken(user.id, org.id);
    await client.query(
      `UPDATE "ApiToken" SET "revokedAt" = '2020-01-01 00:00:00' WHERE id = $1`,
      [alreadyRevoked],
    );
    const newRaw = randomRut();
    const spelled = formatRut(newRaw);
    expect((await call("get", "/auth/profile", cookie)).status).toBe(200);

    const response = await patchUser(user.id, { rut: spelled });

    expect(response.status).toBe(200);
    expect(response.body.user.rut).toBe(spelled);
    expect((await storedUser(user.id)).rut).toBe(newRaw);
    expect(await sessionCount(user.id)).toBe(0);
    expect(await revokedAt(apiToken)).not.toBeNull();
    expect(await revokedAt(alreadyRevoked)).toBe("2020-01-01 00:00:00");
    const old = await call("get", "/auth/profile", cookie);
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe("UNAUTHENTICATED");
    await expect(
      auth.login({ rut: user.rut, password: PASSWORD }),
    ).rejects.toMatchObject({ status: 401 });
    const fresh = await auth.login({ rut: spelled, password: PASSWORD });
    expect(fresh.sessionToken).toBeTruthy();
    const rows = await auditRows("USER_UPDATED", user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: platform.id,
      actorIsTarget: false,
    });
    expect(JSON.stringify(rows)).not.toContain(newRaw);
  });

  it("changes name and RUT together in one audit row", async () => {
    const { user } = await memberWithSecrets("ac03-both");

    const response = await patchUser(user.id, {
      name: "Both Changed",
      rut: formatRut(randomRut()),
    });

    expect(response.status).toBe(200);
    expect(response.body.user.name).toBe("Both Changed");
    expect(await auditRows("USER_UPDATED", user.id)).toHaveLength(1);
  });

  it("is a no-op for the same values: 200, nothing revoked, no audit", async () => {
    const { user, cookie, apiToken } = await memberWithSecrets("ac03-noop");
    const before = await storedUser(user.id);

    const sameName = await patchUser(user.id, { name: ` ${before.name} ` });
    const sameRut = await patchUser(user.id, { rut: user.rut });
    const sameBoth = await patchUser(user.id, {
      name: before.name,
      rut: user.rawRut.toLowerCase(),
    });

    for (const response of [sameName, sameRut, sameBoth]) {
      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe(user.id);
    }
    expect(await storedUser(user.id)).toEqual(before);
    expect((await call("get", "/auth/profile", cookie)).status).toBe(200);
    expect(await revokedAt(apiToken)).toBeNull();
    expect(await auditRows("USER_UPDATED", user.id)).toEqual([]);
  });

  it("answers 409 USER_CONFLICT for a duplicate RUT and changes nothing", async () => {
    const { user, cookie, apiToken } = await memberWithSecrets("ac03-dup");
    const other = await makeUser("Holder Of Rut");
    const before = await storedUser(user.id);

    const response = await patchUser(user.id, {
      name: "Should Not Apply",
      rut: other.rut,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("USER_CONFLICT");
    expect(await storedUser(user.id)).toEqual(before);
    expect((await call("get", "/auth/profile", cookie)).status).toBe(200);
    expect(await revokedAt(apiToken)).toBeNull();
    expect(await auditRows("USER_UPDATED", user.id)).toEqual([]);
  });

  it("lets the platform administrator rename themselves but not change their own RUT", async () => {
    const adminUser = await makeUser("Self Patch Admin");
    await designatePlatformAdministrator(adminUser.id);
    const adminCookie = await cookieFor(adminUser);
    try {
      const rename = await patchUser(
        adminUser.id,
        { name: "Self Renamed" },
        adminCookie,
      );
      expect(rename.status).toBe(200);
      expect(rename.body.user.name).toBe("Self Renamed");
      const rows = await auditRows("USER_UPDATED", adminUser.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: adminUser.id,
        actorIsTarget: true,
      });

      const rutChange = await patchUser(
        adminUser.id,
        { rut: formatRut(randomRut()) },
        adminCookie,
      );
      expect(rutChange.status).toBe(409);
      expect(rutChange.body.error.code).toBe("SELF_ACTION_FORBIDDEN");
      expect((await storedUser(adminUser.id)).rut).toBe(adminUser.rawRut);
      expect((await call("get", "/auth/profile", adminCookie)).status).toBe(
        200,
      );

      const sameRut = await patchUser(
        adminUser.id,
        { rut: adminUser.rut },
        adminCookie,
      );
      expect(sameRut.status).toBe(200);
      expect(await auditRows("USER_UPDATED", adminUser.id)).toHaveLength(1);
    } finally {
      await designatePlatformAdministrator(platform.id);
    }
  });
});

describe("AC-04 POST /api/v1/admin/users/{userId}/password-reset", () => {
  it("answers 401/403/404 with a 200 control", async () => {
    const { adminCookie, plainCookie } = await orgAdminAndUser("ac04-authz");
    const target = await makeUser("Reset Target");

    expect((await resetPassword(target.id, {}, null)).status).toBe(401);
    for (const cookie of [adminCookie, plainCookie]) {
      const forbidden = await resetPassword(target.id, {}, cookie);
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.error.code).toBe("FORBIDDEN");
    }
    const missing = await resetPassword(randomUUID());
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
    expect((await resetPassword(target.id)).status).toBe(200);
  });

  it("rejects a cross-origin write", async () => {
    const target = await makeUser("Reset Csrf");
    const before = await storedUser(target.id);
    const response = await request(app)
      .post(`/api/v1/admin/users/${target.id}/password-reset`)
      .set({ Host: "127.0.0.1", Origin: "http://evil.example" })
      .set("Cookie", platformCookie)
      .send({});
    expect(response.status).toBe(403);
    expect((await storedUser(target.id)).passwordHash).toBe(
      before.passwordHash,
    );
    // Control: the same write from the same origin goes through.
    expect((await resetPassword(target.id)).status).toBe(200);
  });

  it.each([
    ["unknown field", { temporaryPassword: "defined-pass-1", extra: 1 }],
    ["7 characters", { temporaryPassword: "x".repeat(7) }],
    ["257 characters", { temporaryPassword: "x".repeat(257) }],
    ["numeric password", { temporaryPassword: 12345678 }],
  ])("rejects %s with 400 and changes nothing", async (_label, body) => {
    const { user, cookie } = await memberWithSecrets("ac04-validation");
    const before = await storedUser(user.id);

    const response = await resetPassword(user.id, body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("defined-pass-1");
    expect(await storedUser(user.id)).toEqual(before);
    expect((await call("get", "/auth/profile", cookie)).status).toBe(200);
  });

  it("generates a password, answers no-store and runs the whole forced-change flow", async () => {
    const { user, cookie, apiToken } = await memberWithSecrets("ac04-gen");
    await cookieFor(user);

    const response = await resetPassword(user.id, {});

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expect(Object.keys(response.body).sort()).toEqual([
      "expiresAt",
      "temporaryPassword",
    ]);
    const temporary = response.body.temporaryPassword as string;
    expect(temporary.length).toBeGreaterThanOrEqual(24);
    const stored = await storedUser(user.id);
    expect(stored.mustChangePassword).toBe(true);
    expect(stored.expiresAt).toBe(response.body.expiresAt);
    const lifetime = Date.parse(response.body.expiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(24 * 3_600_000 - 60_000);
    expect(lifetime).toBeLessThanOrEqual(24 * 3_600_000);
    expect(stored.passwordHash).not.toContain(temporary);

    // Old credentials are dead.
    expect(await sessionCount(user.id)).toBe(0);
    expect((await call("get", "/auth/profile", cookie)).status).toBe(401);
    expect(await revokedAt(apiToken)).not.toBeNull();
    await expect(
      auth.login({ rut: user.rut, password: PASSWORD }),
    ).rejects.toMatchObject({ status: 401 });

    // The temporary password logs in, but every other route demands the change.
    const session = await auth.login({ rut: user.rut, password: temporary });
    const temporaryCookie = `invoiceops_session=${session.sessionToken}`;
    expect((await call("get", "/auth/profile", temporaryCookie)).status).toBe(
      200,
    );
    const blocked = await call("get", "/organizations", temporaryCookie);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("ONBOARDING_REQUIRED");
    const changed = await call(
      "post",
      "/auth/change-password",
      temporaryCookie,
      { currentPassword: temporary, newPassword: "a-brand-new-password-1" },
    );
    expect(changed.status).toBe(204);
  });

  it("applies an admin-defined password and does not echo it", async () => {
    const { user } = await memberWithSecrets("ac04-defined");
    const defined = `Defined-${token()}`;

    const response = await resetPassword(user.id, {
      temporaryPassword: defined,
    });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expect(Object.keys(response.body)).toEqual(["expiresAt"]);
    expect(JSON.stringify(response.body)).not.toContain(defined);
    const session = await auth.login({ rut: user.rut, password: defined });
    expect(session.sessionToken).toBeTruthy();
    expect((await storedUser(user.id)).mustChangePassword).toBe(true);
  });

  it("refuses to reset the actor's own password", async () => {
    const adminUser = await makeUser("Self Reset Admin");
    await designatePlatformAdministrator(adminUser.id);
    const adminCookie = await cookieFor(adminUser);
    try {
      const before = await storedUser(adminUser.id);
      const response = await resetPassword(adminUser.id, {}, adminCookie);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("SELF_ACTION_FORBIDDEN");
      expect(await storedUser(adminUser.id)).toEqual(before);
      expect((await call("get", "/auth/profile", adminCookie)).status).toBe(
        200,
      );
      expect(await auditRows("PASSWORD_RESET", adminUser.id)).toEqual([]);
    } finally {
      await designatePlatformAdministrator(platform.id);
    }
  });

  it("resets a disabled user, who stays disabled and cannot log in", async () => {
    const { user } = await memberWithSecrets("ac04-disabled");
    await disableDirectly(user.id);

    const response = await resetPassword(user.id, {});

    expect(response.status).toBe(200);
    const stored = await storedUser(user.id);
    expect(stored.disabledAt).not.toBeNull();
    expect(stored.mustChangePassword).toBe(true);
    await expect(
      auth.login({ rut: user.rut, password: response.body.temporaryPassword }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("AC-07 password reset racing with login", () => {
  it("never leaves a live session created with the old credential", async () => {
    for (let round = 0; round < 10; round += 1) {
      const user = await makeUser(`Race ${round}`);
      const defined = `Race-${token()}`;

      const [first, second, reset] = await Promise.allSettled([
        auth.login({ rut: user.rut, password: PASSWORD }),
        auth.login({ rut: user.rut, password: PASSWORD }),
        resetPassword(user.id, { temporaryPassword: defined }),
      ]);

      expect(reset.status).toBe("fulfilled");
      if (reset.status === "fulfilled") expect(reset.value.status).toBe(200);
      // Logins either lost cleanly (401) or won before the reset; in both
      // cases the reset deleted every session after its commit point.
      for (const login of [first, second]) {
        if (login.status === "rejected") {
          expect(login.reason).toMatchObject({ status: 401 });
        }
      }
      expect(await sessionCount(user.id)).toBe(0);
      await expect(
        auth.login({ rut: user.rut, password: PASSWORD }),
      ).rejects.toMatchObject({ status: 401 });
      expect(
        (await auth.login({ rut: user.rut, password: defined })).sessionToken,
      ).toBeTruthy();
    }
  });
});

describe("AC-07 RUT change racing with login", () => {
  it("rejects a login whose credential was read before the RUT changed", async () => {
    const user = await makeUser("Rut Gate");
    const oldRut = user.rut;
    // The verifier parks the login after its first read, so the RUT change
    // commits between that read and the session creation.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked!: () => void;
    const reached = new Promise<void>((resolve) => {
      parked = resolve;
    });
    const gated = createAuthService(prisma, {
      verifyPassword: async () => {
        parked();
        await gate;
        return true;
      },
    });

    const login = gated.login({ rut: oldRut, password: PASSWORD });
    const settled = login.then(
      () => "fulfilled" as const,
      (error: { status?: number }) => error,
    );
    await reached;
    const changed = await patchUser(user.id, { rut: formatRut(randomRut()) });
    expect(changed.status).toBe(200);
    release();

    expect(await settled).toMatchObject({ status: 401 });
    expect(await sessionCount(user.id)).toBe(0);
  });

  it("never leaves a live session created with the old RUT", async () => {
    for (let round = 0; round < 10; round += 1) {
      const user = await makeUser(`Rut Race ${round}`);
      const oldRut = user.rut;

      const [first, second, patch] = await Promise.allSettled([
        auth.login({ rut: oldRut, password: PASSWORD }),
        auth.login({ rut: oldRut, password: PASSWORD }),
        patchUser(user.id, { rut: formatRut(randomRut()) }),
      ]);

      expect(patch.status).toBe("fulfilled");
      if (patch.status === "fulfilled") expect(patch.value.status).toBe(200);
      for (const login of [first, second]) {
        if (login.status === "rejected") {
          expect(login.reason).toMatchObject({ status: 401 });
        }
      }
      expect(await sessionCount(user.id)).toBe(0);
      await expect(
        auth.login({ rut: oldRut, password: PASSWORD }),
      ).rejects.toMatchObject({ status: 401 });
    }
  });
});

describe("AC-11 audit", () => {
  it("writes PASSWORD_RESET with actor and target ids only and no secret", async () => {
    const { user } = await memberWithSecrets("ac11-reset");
    const defined = `Audit-${token()}`;
    const writers = (["info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );

    const response = await resetPassword(user.id, {
      temporaryPassword: defined,
    });
    const generated = await resetPassword(user.id, {});
    const logged = writers
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .join("\n");
    vi.restoreAllMocks();

    expect(response.status).toBe(200);
    const rows = await auditRows("PASSWORD_RESET", user.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toEqual({
        type: "PASSWORD_RESET",
        actorUserId: platform.id,
        targetUserId: user.id,
        organizationId: null,
        groupId: null,
        actorIsTarget: false,
        role: null,
        previousRole: null,
      });
    }
    const full = await client.query(
      `SELECT * FROM "PlatformAdministrativeAuditEvent" WHERE "targetUserId" = $1`,
      [user.id],
    );
    const serialized = JSON.stringify(full.rows);
    expect(serialized).not.toContain(defined);
    expect(serialized).not.toContain(generated.body.temporaryPassword);
    expect(serialized).not.toContain((await storedUser(user.id)).passwordHash);
    expect(logged).not.toContain(defined);
    expect(logged).not.toContain(generated.body.temporaryPassword);
  });

  it("writes no audit row for a rejected reset or patch", async () => {
    const target = await makeUser("Audit Rejected");
    const badReset = await resetPassword(target.id, {
      temporaryPassword: "short",
    });
    const badPatch = await patchUser(target.id, {});
    expect(badReset.status).toBe(400);
    expect(badPatch.status).toBe(400);
    expect(await auditRows("PASSWORD_RESET", target.id)).toEqual([]);
    expect(await auditRows("USER_UPDATED", target.id)).toEqual([]);
  });

  it("emits the audit.user_updated log only for a real change, with ids only", async () => {
    const target = await makeUser("Log Target");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await patchUser(target.id, { name: "Log Target" });
    await patchUser(target.id, { name: "Log Renamed" });
    const lines = info.mock.calls.map(([line]) => String(line));
    vi.restoreAllMocks();

    const updates = lines.filter((line) => line.includes("audit.user_updated"));
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0]!)).toMatchObject({
      event: "audit.user_updated",
      actorUserId: platform.id,
      targetUserId: target.id,
    });
    expect(updates[0]).not.toContain("Log Renamed");
    expect(updates[0]).not.toContain(target.rawRut);
  });
});
