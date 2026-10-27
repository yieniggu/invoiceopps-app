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
const app = createApp(database, auth);

const NO_FLAGS = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};
const ALL_FLAGS = {
  readInvoices: true,
  createInvoices: true,
  deleteOwnInvoices: true,
  deleteOthersInvoices: true,
};

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

const makeGroup = (
  organizationId: string,
  name = "Group",
  flags: Partial<typeof ALL_FLAGS> = {},
) => prisma.group.create({ data: { organizationId, name, ...flags } });

const addToGroup = (groupId: string, userId: string, organizationId: string) =>
  prisma.groupMembership.create({ data: { groupId, userId, organizationId } });

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

type ProfileContext = {
  groupId: string;
  capabilities: typeof ALL_FLAGS;
};

async function contextsOf(cookie: string) {
  const response = await call("get", "/auth/profile", cookie);
  expect(response.status).toBe(200);
  return response.body.profile.contexts as ProfileContext[];
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

async function scenario() {
  const org = await makeOrg("grp");
  const admin = await makeUser("Ada Admin");
  const member = await makeUser("Uma User");
  const outsider = await makeUser();
  await join(admin.id, org.id, "ADMIN");
  await join(member.id, org.id, "USER");
  const group = await makeGroup(org.id, "Finance");
  return { org, admin, member, outsider, group };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

describe("RP0-07 GET /organizations/{organizationId}/groups", () => {
  it("lists every group for an ADMIN and only own groups for a USER, with the group DTO", async () => {
    const s = await scenario();
    const second = await makeGroup(s.org.id, "Zeta", { readInvoices: true });
    await addToGroup(second.id, s.member.id, s.org.id);

    const asAdmin = await call(
      "get",
      `/organizations/${s.org.id}/groups`,
      await cookieFor(s.admin),
    );
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.groups).toEqual([
      {
        id: s.group.id,
        organizationId: s.org.id,
        name: "Finance",
        description: null,
        permissions: NO_FLAGS,
      },
      {
        id: second.id,
        organizationId: s.org.id,
        name: "Zeta",
        description: null,
        permissions: { ...NO_FLAGS, readInvoices: true },
      },
    ]);

    const asMember = await call(
      "get",
      `/organizations/${s.org.id}/groups`,
      await cookieFor(s.member),
    );
    expect(asMember.status).toBe(200);
    expect(
      (asMember.body.groups as Array<{ id: string }>).map((group) => group.id),
    ).toEqual([second.id]);
  });

  it("answers 404 to a non-member and to the platform administrator without membership", async () => {
    const s = await scenario();
    for (const cookie of [await cookieFor(s.outsider), platformCookie]) {
      const response = await call(
        "get",
        `/organizations/${s.org.id}/groups`,
        cookie,
      );
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    }
  });
});

describe("RP0-07 POST /organizations/{organizationId}/groups", () => {
  it("creates a group with every flag false and does not add the creator", async () => {
    const s = await scenario();

    const response = await call(
      "post",
      `/organizations/${s.org.id}/groups`,
      await cookieFor(s.admin),
      { name: "Operations", description: "Back office" },
    );

    expect(response.status).toBe(201);
    expect(response.body.group).toMatchObject({
      organizationId: s.org.id,
      name: "Operations",
      description: "Back office",
      permissions: NO_FLAGS,
    });
    expect(
      await prisma.groupMembership.count({
        where: { groupId: response.body.group.id },
      }),
    ).toBe(0);
  });

  it.each([
    ["a permissions field", { name: "X", permissions: ALL_FLAGS }],
    ["a flag at the top level", { name: "X", readInvoices: true }],
    ["a missing name", { description: "no name" }],
  ])("rejects %s with 400 and persists nothing", async (_label, body) => {
    const s = await scenario();
    const before = await prisma.group.count({
      where: { organizationId: s.org.id },
    });

    const response = await call(
      "post",
      `/organizations/${s.org.id}/groups`,
      await cookieFor(s.admin),
      body,
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(
      await prisma.group.count({ where: { organizationId: s.org.id } }),
    ).toBe(before);
  });

  it("answers 403 to a USER member and 404 to outsiders and the platform administrator", async () => {
    const s = await scenario();
    const send = (cookie: string) =>
      call("post", `/organizations/${s.org.id}/groups`, cookie, { name: "N" });

    expect((await send(await cookieFor(s.member))).status).toBe(403);
    expect((await send(await cookieFor(s.outsider))).status).toBe(404);
    expect((await send(platformCookie)).status).toBe(404);
    expect(
      await prisma.group.count({ where: { organizationId: s.org.id } }),
    ).toBe(1);
  });
});

describe("RP0-07 PATCH /organizations/{organizationId}/groups/{groupId}", () => {
  const path = (s: Scenario, groupId = s.group.id) =>
    `/organizations/${s.org.id}/groups/${groupId}`;

  it("replaces the four flags atomically and answers 200 with the group DTO", async () => {
    const s = await scenario();
    const cookie = await cookieFor(s.admin);

    const first = await call("patch", path(s), cookie, {
      permissions: { ...NO_FLAGS, createInvoices: true },
    });
    expect(first.status).toBe(200);
    expect(first.body.group).toMatchObject({
      id: s.group.id,
      name: "Finance",
      permissions: { ...NO_FLAGS, createInvoices: true },
    });

    // create=true / read=false stays as sent: no implication between flags.
    const second = await call("patch", path(s), cookie, {
      permissions: { ...NO_FLAGS, deleteOthersInvoices: true },
    });
    expect(second.status).toBe(200);
    const stored = await prisma.group.findUniqueOrThrow({
      where: { id: s.group.id },
    });
    expect({
      readInvoices: stored.readInvoices,
      createInvoices: stored.createInvoices,
      deleteOwnInvoices: stored.deleteOwnInvoices,
      deleteOthersInvoices: stored.deleteOthersInvoices,
    }).toEqual({ ...NO_FLAGS, deleteOthersInvoices: true });
  });

  it.each([
    ["a missing flag", { permissions: { readInvoices: true } }],
    [
      "a non-boolean flag",
      { permissions: { ...NO_FLAGS, readInvoices: "yes" } },
    ],
    ["a missing permissions object", {}],
    ["an extra top-level field", { permissions: NO_FLAGS, name: "Renamed" }],
    [
      "an extra field inside permissions",
      { permissions: { ...NO_FLAGS, adminOverride: true } },
    ],
    ["the legacy name/description body", { name: "Renamed" }],
  ])("rejects %s with 400 and changes nothing", async (_label, body) => {
    const s = await scenario();

    const response = await call(
      "patch",
      path(s),
      await cookieFor(s.admin),
      body,
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    const stored = await prisma.group.findUniqueOrThrow({
      where: { id: s.group.id },
    });
    expect(stored.name).toBe("Finance");
    expect(stored.readInvoices).toBe(false);
  });

  it("answers 403 to a USER member, 404 to outsiders, the platform administrator and a group of another organization", async () => {
    const s = await scenario();
    const foreignOrg = await makeOrg("foreign");
    const foreignGroup = await makeGroup(foreignOrg.id, "Foreign");
    const body = { permissions: ALL_FLAGS };

    expect(
      (await call("patch", path(s), await cookieFor(s.member), body)).status,
    ).toBe(403);
    expect(
      (await call("patch", path(s), await cookieFor(s.outsider), body)).status,
    ).toBe(404);
    expect((await call("patch", path(s), platformCookie, body)).status).toBe(
      404,
    );
    const crossTenant = await call(
      "patch",
      path(s, foreignGroup.id),
      await cookieFor(s.admin),
      body,
    );
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.error.code).toBe("NOT_FOUND");

    for (const id of [s.group.id, foreignGroup.id]) {
      expect(
        (await prisma.group.findUniqueOrThrow({ where: { id } })).readInvoices,
      ).toBe(false);
    }
  });
});

describe("RP0-07 group memberships", () => {
  const base = (s: Scenario) =>
    `/organizations/${s.org.id}/groups/${s.group.id}/memberships`;

  it("adds an organization member, rejects duplicates and non-members, lists and removes", async () => {
    const s = await scenario();
    const cookie = await cookieFor(s.admin);

    const created = await call("post", base(s), cookie, {
      userId: s.member.id,
    });
    expect(created.status).toBe(201);
    expect(created.body.membership).toEqual({
      userId: s.member.id,
      groupId: s.group.id,
      organizationId: s.org.id,
    });

    const duplicate = await call("post", base(s), cookie, {
      userId: s.member.id,
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("MEMBERSHIP_CONFLICT");

    const notInOrg = await call("post", base(s), cookie, {
      userId: s.outsider.id,
    });
    expect(notInOrg.status).toBe(409);
    expect(notInOrg.body.error.code).toBe("ORGANIZATION_MEMBERSHIP_REQUIRED");

    const listed = await call("get", base(s), cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.memberships).toEqual([
      {
        userId: s.member.id,
        groupId: s.group.id,
        organizationId: s.org.id,
        user: { id: s.member.id, name: "Uma User", rut: s.member.rawRut },
      },
    ]);

    const removed = await call("delete", `${base(s)}/${s.member.id}`, cookie);
    expect(removed.status).toBe(204);
    const again = await call("delete", `${base(s)}/${s.member.id}`, cookie);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("NOT_FOUND");
  });

  it.each([
    ["permissions", { permissions: ALL_FLAGS }],
    ["a flag", { readInvoices: true }],
  ])(
    "rejects %s in the membership payload and persists nothing",
    async (_label, extra) => {
      const s = await scenario();

      const response = await call("post", base(s), await cookieFor(s.admin), {
        userId: s.member.id,
        ...extra,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(
        await prisma.groupMembership.count({ where: { groupId: s.group.id } }),
      ).toBe(0);
      expect(
        (await prisma.group.findUniqueOrThrow({ where: { id: s.group.id } }))
          .readInvoices,
      ).toBe(false);
    },
  );

  it("answers 403 to a USER member and 404 to outsiders, the platform administrator and a group of another organization", async () => {
    const s = await scenario();
    const foreignOrg = await makeOrg("foreign-membership");
    const foreignGroup = await makeGroup(foreignOrg.id, "Foreign");
    const body = { userId: s.member.id };

    expect(
      (await call("post", base(s), await cookieFor(s.member), body)).status,
    ).toBe(403);
    expect(
      (await call("post", base(s), await cookieFor(s.outsider), body)).status,
    ).toBe(404);
    expect((await call("post", base(s), platformCookie, body)).status).toBe(
      404,
    );
    expect((await call("get", base(s), await cookieFor(s.member))).status).toBe(
      403,
    );
    expect(
      (
        await call(
          "post",
          `/organizations/${s.org.id}/groups/${foreignGroup.id}/memberships`,
          await cookieFor(s.admin),
          body,
        )
      ).status,
    ).toBe(404);
    expect(
      await prisma.groupMembership.count({
        where: { organizationId: s.org.id },
      }),
    ).toBe(0);
  });
});

describe("RP0-07 shared group flags and profile capabilities", () => {
  it("shares the flags between members, applies PATCH to both on their next request and leaves other groups alone", async () => {
    const s = await scenario();
    const second = await makeUser("Second Member");
    await join(second.id, s.org.id, "USER");
    const other = await makeGroup(s.org.id, "Other", { readInvoices: true });
    for (const user of [s.member, second]) {
      await addToGroup(s.group.id, user.id, s.org.id);
    }
    await addToGroup(other.id, s.member.id, s.org.id);
    const cookies = [await cookieFor(s.member), await cookieFor(second)];

    const flagsOf = async (cookie: string, groupId: string) =>
      (await contextsOf(cookie)).find((context) => context.groupId === groupId)
        ?.capabilities;

    expect(await flagsOf(cookies[0]!, s.group.id)).toEqual(NO_FLAGS);
    expect(await flagsOf(cookies[1]!, s.group.id)).toEqual(NO_FLAGS);

    const patch = await call(
      "patch",
      `/organizations/${s.org.id}/groups/${s.group.id}`,
      await cookieFor(s.admin),
      {
        permissions: {
          readInvoices: true,
          createInvoices: false,
          deleteOwnInvoices: true,
          deleteOthersInvoices: false,
        },
      },
    );
    expect(patch.status).toBe(200);

    const expected = {
      readInvoices: true,
      createInvoices: false,
      deleteOwnInvoices: true,
      deleteOthersInvoices: false,
    };
    expect(await flagsOf(cookies[0]!, s.group.id)).toEqual(expected);
    expect(await flagsOf(cookies[1]!, s.group.id)).toEqual(expected);
    // The other group of the same person keeps its own configuration.
    expect(await flagsOf(cookies[0]!, other.id)).toEqual({
      ...NO_FLAGS,
      readInvoices: true,
    });
  });

  it("gives a person in two groups the flags of each group", async () => {
    const s = await scenario();
    const second = await makeGroup(s.org.id, "Second", {
      createInvoices: true,
      deleteOthersInvoices: true,
    });
    await addToGroup(s.group.id, s.member.id, s.org.id);
    await addToGroup(second.id, s.member.id, s.org.id);
    await prisma.group.update({
      where: { id: s.group.id },
      data: { readInvoices: true },
    });

    const contexts = await contextsOf(await cookieFor(s.member));

    expect(
      Object.fromEntries(
        contexts.map((context) => [context.groupId, context.capabilities]),
      ),
    ).toEqual({
      [s.group.id]: { ...NO_FLAGS, readInvoices: true },
      [second.id]: {
        ...NO_FLAGS,
        createInvoices: true,
        deleteOthersInvoices: true,
      },
    });
  });

  it("gives an ADMIN and the platform administrator no invoice capabilities from their role", async () => {
    const s = await scenario();
    await prisma.group.update({
      where: { id: s.group.id },
      data: ALL_FLAGS,
    });

    expect(await contextsOf(await cookieFor(s.admin))).toEqual([]);
    expect(await contextsOf(platformCookie)).toEqual([]);
  });
});

describe("RP0-07 serialization on the group row", () => {
  // Waits (bounded) until a backend is blocked on a row lock running a
  // statement that matches `pattern`; this is the deterministic ordering
  // signal, no sleep is used as an assertion.
  async function waitUntilBlocked(pattern: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await client.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
           AND query ILIKE $1`,
        [pattern],
      );
      if (result.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no backend blocked on a lock matching ${pattern}`);
  }

  it("makes PATCH wait for a transaction holding the group row lock", async () => {
    const s = await scenario();
    const cookie = await cookieFor(s.admin);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query('SELECT id FROM "Group" WHERE id = $1 FOR UPDATE', [
        s.group.id,
      ]);

      let settled = false;
      const pending = call(
        "patch",
        `/organizations/${s.org.id}/groups/${s.group.id}`,
        cookie,
        { permissions: ALL_FLAGS },
      ).then((response) => {
        settled = true;
        return response;
      });

      await waitUntilBlocked('%FROM "Group" WHERE id%FOR UPDATE%');
      expect(settled).toBe(false);
      expect(
        (await prisma.group.findUniqueOrThrow({ where: { id: s.group.id } }))
          .readInvoices,
      ).toBe(false);

      await holder.query("COMMIT");
      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.body.group.permissions).toEqual(ALL_FLAGS);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });

  it("makes organization membership removal wait for the group rows of that organization", async () => {
    const s = await scenario();
    await addToGroup(s.group.id, s.member.id, s.org.id);
    const cookie = await cookieFor(s.admin);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query('SELECT id FROM "Group" WHERE id = $1 FOR UPDATE', [
        s.group.id,
      ]);

      let settled = false;
      const pending = call(
        "delete",
        `/organizations/${s.org.id}/memberships/${s.member.id}`,
        cookie,
      ).then((response) => {
        settled = true;
        return response;
      });

      await waitUntilBlocked(
        '%FROM "Group" WHERE "organizationId"%FOR UPDATE%',
      );
      expect(settled).toBe(false);
      expect(
        await prisma.organizationMembership.count({
          where: { userId: s.member.id, organizationId: s.org.id },
        }),
      ).toBe(1);

      await holder.query("COMMIT");
      expect((await pending).status).toBe(204);
      expect(
        await prisma.groupMembership.count({
          where: { userId: s.member.id, organizationId: s.org.id },
        }),
      ).toBe(0);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
  });
});
