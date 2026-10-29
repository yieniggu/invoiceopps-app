import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import {
  membershipFixtures,
  NO_FLAGS,
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
  cookieFor,
  call,
  designatePlatformAdministrator,
} = membershipFixtures({ prisma, client, auth, app, url });

const MISSING = "00000000-0000-4000-8000-000000000000";
// Prisma stores DateTime as UTC wall-clock time in a timestamp column, while
// node-postgres reads and writes it in the host time zone: compute in SQL.
const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;

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

const token = () => randomUUID().replaceAll("-", "").slice(0, 10);

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

async function setEmail(userId: string, email: string) {
  await client.query(`UPDATE "User" SET email = $2 WHERE id = $1`, [
    userId,
    email,
  ]);
}

async function auditRows(organizationId: string) {
  const result = await client.query(
    `SELECT type::text AS type, "actorUserId", "targetUserId", "organizationId"
     FROM "PlatformAdministrativeAuditEvent"
     WHERE type::text = 'ORGANIZATION_UPDATED' AND "organizationId" = $1`,
    [organizationId],
  );
  return result.rows as Array<{
    type: string;
    actorUserId: string;
    targetUserId: string | null;
    organizationId: string;
  }>;
}

async function orgScenario(label: string) {
  const org = await makeOrg(`${label}-${token()}`);
  const admin = await makeUser("Ada Admin");
  const member = await makeUser("Uma User");
  const outsider = await makeUser("Otto Outsider");
  await join(admin.id, org.id, "ADMIN");
  await join(member.id, org.id, "USER");
  return {
    org,
    admin,
    member,
    outsider,
    adminCookie: await cookieFor(admin),
    memberCookie: await cookieFor(member),
    outsiderCookie: await cookieFor(outsider),
  };
}

describe("AC-08 PATCH /organizations/{organizationId}", () => {
  it("lets an ADMIN rename, set a description and audit once with ids only", async () => {
    const s = await orgScenario("patch");
    const response = await call(
      "patch",
      `/organizations/${s.org.id}`,
      s.adminCookie,
      { name: "  Renamed Org  ", description: "  About us  " },
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      organization: {
        id: s.org.id,
        name: "Renamed Org",
        slug: s.org.slug,
        description: "About us",
      },
    });
    const stored = await prisma.organization.findUniqueOrThrow({
      where: { id: s.org.id },
    });
    expect(stored.name).toBe("Renamed Org");
    expect(stored.slug).toBe(s.org.slug);

    const rows = await auditRows(s.org.id);
    expect(rows).toEqual([
      {
        type: "ORGANIZATION_UPDATED",
        actorUserId: s.admin.id,
        targetUserId: null,
        organizationId: s.org.id,
      },
    ]);
  });

  it("clears the description with null or a blank string", async () => {
    const s = await orgScenario("patch-clear");
    await call("patch", `/organizations/${s.org.id}`, s.adminCookie, {
      description: "something",
    });
    const cleared = await call(
      "patch",
      `/organizations/${s.org.id}`,
      s.adminCookie,
      { description: "   " },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.organization.description).toBeNull();
    const again = await call(
      "patch",
      `/organizations/${s.org.id}`,
      s.adminCookie,
      { description: "back" },
    );
    expect(again.body.organization.description).toBe("back");
    const nulled = await call(
      "patch",
      `/organizations/${s.org.id}`,
      s.adminCookie,
      { description: null },
    );
    expect(nulled.status).toBe(200);
    expect(nulled.body.organization.description).toBeNull();
  });

  it("lets the platform administrator update without any membership", async () => {
    const s = await orgScenario("patch-platform");
    const response = await call(
      "patch",
      `/organizations/${s.org.id}`,
      platformCookie,
      { name: "By Platform" },
    );
    expect(response.status).toBe(200);
    expect(response.body.organization.name).toBe("By Platform");
    expect((await auditRows(s.org.id))[0]?.actorUserId).toBe(platform.id);
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: s.org.id, userId: platform.id },
      }),
    ).toBe(0);
  });

  it("answers 403 to a plain member, 404 to a non member and 404 for a missing organization, with a 200 control", async () => {
    const s = await orgScenario("patch-authz");
    const patch = (cookie: string, id = s.org.id) =>
      call("patch", `/organizations/${id}`, cookie, { name: "Changed" });

    // Control: the route exists and an ADMIN succeeds.
    expect((await patch(s.adminCookie)).status).toBe(200);
    const before = (await auditRows(s.org.id)).length;

    const member = await patch(s.memberCookie);
    expect(member.status).toBe(403);
    expect(member.body.error.code).toBe("FORBIDDEN");
    const outsider = await patch(s.outsiderCookie);
    expect(outsider.status).toBe(404);
    expect(outsider.body.error.code).toBe("NOT_FOUND");
    const missingForOutsider = await patch(s.outsiderCookie, MISSING);
    expect(missingForOutsider.status).toBe(404);
    expect(missingForOutsider.body).toEqual(outsider.body);
    expect((await patch(platformCookie, MISSING)).status).toBe(404);

    expect((await auditRows(s.org.id)).length).toBe(before);
    const stored = await prisma.organization.findUniqueOrThrow({
      where: { id: s.org.id },
    });
    expect(stored.name).toBe("Changed");
  });

  it("validates the body before the authority and never changes the slug", async () => {
    const s = await orgScenario("patch-validate");
    expect(
      (
        await call("patch", `/organizations/${s.org.id}`, s.adminCookie, {
          name: "Valid",
        })
      ).status,
    ).toBe(200);
    for (const body of [{}, { slug: "new-slug" }, { name: "X", slug: "y" }]) {
      const asMember = await call(
        "patch",
        `/organizations/${s.org.id}`,
        s.memberCookie,
        body,
      );
      expect(asMember.status).toBe(400);
      const asAdmin = await call(
        "patch",
        `/organizations/${s.org.id}`,
        s.adminCookie,
        body,
      );
      expect(asAdmin.status).toBe(400);
    }
    const stored = await prisma.organization.findUniqueOrThrow({
      where: { id: s.org.id },
    });
    expect(stored.slug).toBe(s.org.slug);
  });

  it("answers 200 without an audit row or log for a no-op and logs ids only for a change", async () => {
    const s = await orgScenario("patch-noop");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const noop = await call(
      "patch",
      `/organizations/${s.org.id}`,
      s.adminCookie,
      { name: s.org.name },
    );
    const noopLines = info.mock.calls.map(([line]) => String(line));
    expect(noop.status).toBe(200);
    expect(noop.body.organization.name).toBe(s.org.name);
    expect(await auditRows(s.org.id)).toEqual([]);
    expect(noopLines.filter((l) => l.includes("audit.org_updated"))).toEqual(
      [],
    );

    await call("patch", `/organizations/${s.org.id}`, s.adminCookie, {
      name: "Secret New Name",
    });
    const lines = info.mock.calls.map(([line]) => String(line));
    vi.restoreAllMocks();
    const updates = lines.filter((l) => l.includes("audit.org_updated"));
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0]!)).toMatchObject({
      event: "audit.org_updated",
      organizationId: s.org.id,
      actorUserId: s.admin.id,
    });
    expect(updates[0]).not.toContain("Secret New Name");
    expect(await auditRows(s.org.id)).toHaveLength(1);
  });
});

describe("AC-22 GET /organizations/{organizationId}/members", () => {
  it("lists the reduced member shape for any member and the platform administrator", async () => {
    const s = await orgScenario("members");
    await setEmail(s.member.id, "uma@example.test");
    await setLastActive(s.member.id, 1);
    const path = `/organizations/${s.org.id}/members`;

    for (const cookie of [s.memberCookie, s.adminCookie, platformCookie]) {
      const response = await call("get", path, cookie);
      expect(response.status).toBe(200);
      expect(response.body.page).toBe(1);
      expect(response.body.pageSize).toBe(20);
      expect(response.body.total).toBe(2);
      expect(response.body.members).toEqual([
        {
          userId: s.admin.id,
          name: "Ada Admin",
          email: null,
          recentlyActive: expect.any(Boolean),
        },
        {
          userId: s.member.id,
          name: "Uma User",
          email: "uma@example.test",
          recentlyActive: true,
        },
      ]);
      const serialized = JSON.stringify(response.body);
      for (const forbidden of [
        "rut",
        "role",
        "permissions",
        "disabledAt",
        "lastActiveAt",
        s.member.rawRut,
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it("answers an indistinguishable 404 to non members, with 200 controls", async () => {
    const s = await orgScenario("members-404");
    const real = await call(
      "get",
      `/organizations/${s.org.id}/members`,
      s.outsiderCookie,
    );
    const missing = await call(
      "get",
      `/organizations/${MISSING}/members`,
      s.outsiderCookie,
    );
    expect(real.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(real.body).toEqual(missing.body);
    // Controls: the same route answers 200 to a member and to the platform.
    expect(
      (await call("get", `/organizations/${s.org.id}/members`, s.memberCookie))
        .status,
    ).toBe(200);
    expect(
      (await call("get", `/organizations/${MISSING}/members`, platformCookie))
        .status,
    ).toBe(404);
    expect(
      (await call("get", `/organizations/${s.org.id}/members`, platformCookie))
        .status,
    ).toBe(200);
  });

  it("reports recentlyActive from the window and false for a disabled user", async () => {
    const s = await orgScenario("members-active");
    const stale = await makeUser("Stale User");
    const disabled = await makeUser("Disabled User");
    await join(stale.id, s.org.id, "USER");
    await join(disabled.id, s.org.id, "USER");
    await setLastActive(s.member.id, 1);
    await setLastActive(stale.id, 20);
    await setLastActive(disabled.id, 1);
    await disableDirectly(disabled.id);

    const response = await call(
      "get",
      `/organizations/${s.org.id}/members`,
      s.adminCookie,
    );
    const byId = new Map(
      response.body.members.map(
        (m: { userId: string; recentlyActive: boolean }) => [
          m.userId,
          m.recentlyActive,
        ],
      ),
    );
    expect(byId.get(s.member.id)).toBe(true);
    expect(byId.get(stale.id)).toBe(false);
    expect(byId.get(disabled.id)).toBe(false);
  });

  it("paginates ordered by name then userId with a stable total", async () => {
    const org = await makeOrg(`members-page-${token()}`);
    const admin = await makeUser("Aaron Admin");
    await join(admin.id, org.id, "ADMIN");
    const twins = [await makeUser("Twin"), await makeUser("Twin")];
    for (const twin of twins) await join(twin.id, org.id, "USER");
    const zed = await makeUser("Zed");
    await join(zed.id, org.id, "USER");
    const cookie = await cookieFor(admin);
    const expected = [admin.id, ...twins.map((t) => t.id).sort(), zed.id];

    const path = `/organizations/${org.id}/members`;
    const pages = [
      await call("get", `${path}?page=1&pageSize=2`, cookie),
      await call("get", `${path}?page=2&pageSize=2`, cookie),
      await call("get", `${path}?page=3&pageSize=2`, cookie),
    ];
    const ids = (r: { body: { members: Array<{ userId: string }> } }) =>
      r.body.members.map((m) => m.userId);
    expect(pages.map((p) => p.body.total)).toEqual([4, 4, 4]);
    expect([...ids(pages[0]!), ...ids(pages[1]!)]).toEqual(expected);
    expect(ids(pages[2]!)).toEqual([]);
    expect(pages[1]!.body.page).toBe(2);
    expect(pages[1]!.body.pageSize).toBe(2);
    // Controls for the 400s: valid bounds succeed.
    expect((await call("get", `${path}?pageSize=100`, cookie)).status).toBe(
      200,
    );
    expect((await call("get", `${path}?pageSize=101`, cookie)).status).toBe(
      400,
    );
    expect((await call("get", `${path}?page=0`, cookie)).status).toBe(400);
  });
});

describe("AC-23 GET /organizations/{organizationId}/memberships", () => {
  it("returns the paginated envelope with disabled and recentlyActive on the user", async () => {
    const s = await orgScenario("memberships");
    const disabled = await makeUser("Dora Disabled");
    await join(disabled.id, s.org.id, "USER");
    await setLastActive(s.member.id, 1);
    await setLastActive(disabled.id, 1);
    await disableDirectly(disabled.id);

    const response = await call(
      "get",
      `/organizations/${s.org.id}/memberships`,
      s.adminCookie,
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ page: 1, pageSize: 20, total: 3 });
    expect(
      response.body.memberships.map((m: { userId: string }) => m.userId),
    ).toEqual([s.admin.id, disabled.id, s.member.id]);
    expect(response.body.memberships).toContainEqual({
      userId: s.member.id,
      organizationId: s.org.id,
      role: "USER",
      permissions: NO_FLAGS,
      groups: [],
      user: {
        id: s.member.id,
        name: "Uma User",
        rut: s.member.rawRut,
        disabled: false,
        recentlyActive: true,
      },
    });
    expect(response.body.memberships).toContainEqual(
      expect.objectContaining({
        userId: disabled.id,
        user: expect.objectContaining({
          disabled: true,
          recentlyActive: false,
        }),
      }),
    );
    expect(JSON.stringify(response.body)).not.toContain("lastActiveAt");
    expect(JSON.stringify(response.body)).not.toContain("disabledAt");
  });

  it("paginates and keeps the ADMIN-only authority", async () => {
    const s = await orgScenario("memberships-page");
    const path = `/organizations/${s.org.id}/memberships`;
    const first = await call("get", `${path}?pageSize=1`, s.adminCookie);
    const second = await call(
      "get",
      `${path}?page=2&pageSize=1`,
      s.adminCookie,
    );
    expect(first.body.total).toBe(2);
    expect(first.body.memberships).toHaveLength(1);
    expect(second.body.memberships).toHaveLength(1);
    expect(first.body.memberships[0].userId).not.toBe(
      second.body.memberships[0].userId,
    );
    expect(
      (await call("get", `${path}?pageSize=1`, platformCookie)).status,
    ).toBe(200);

    const member = await call("get", path, s.memberCookie);
    expect(member.status).toBe(403);
    expect((await call("get", path, s.outsiderCookie)).status).toBe(404);
    expect(
      (await call("get", `${path}?pageSize=0`, s.adminCookie)).status,
    ).toBe(400);
  });
});

describe("GET /organizations/{organizationId}/memberships userIds filter", () => {
  it("holds only the requested members, past the first page, with the same item shape and order", async () => {
    const s = await orgScenario("memberships-ids");
    const zed = await makeUser("Zed Last");
    await join(zed.id, s.org.id, "USER");
    const path = `/organizations/${s.org.id}/memberships`;

    // Zed sorts last: with pageSize=1 he is not on page 1 of the plain list.
    const plain = await call("get", `${path}?pageSize=1`, s.adminCookie);
    expect(plain.body.memberships[0].userId).not.toBe(zed.id);

    const filtered = await call(
      "get",
      `${path}?pageSize=1&userIds=${zed.id}`,
      s.adminCookie,
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body).toMatchObject({ page: 1, pageSize: 1, total: 1 });
    expect(filtered.body.memberships).toHaveLength(1);
    const full = await call("get", path, s.adminCookie);
    expect(filtered.body.memberships[0]).toEqual(
      full.body.memberships.find(
        (m: { userId: string }) => m.userId === zed.id,
      ),
    );

    // Several ids keep the ordering; unknown and outsider ids are absent.
    const several = await call(
      "get",
      `${path}?userIds=${zed.id},${s.admin.id},${MISSING},${s.outsider.id}`,
      s.adminCookie,
    );
    expect(several.body.total).toBe(2);
    expect(
      several.body.memberships.map((m: { userId: string }) => m.userId),
    ).toEqual([s.admin.id, zed.id]);

    // Same authority: a plain member is still refused.
    expect(
      (await call("get", `${path}?userIds=${zed.id}`, s.memberCookie)).status,
    ).toBe(403);
  });
});

describe("AC-10 GET /organizations", () => {
  it("paginates, searches case-insensitively with LIKE escaping and keeps the visibility rules", async () => {
    const key = token();
    const user = await makeUser("Org Member");
    const alpha = await prisma.organization.create({
      data: { name: `Alpha ${key} Corp`, slug: `a-${randomUUID()}` },
    });
    const beta = await prisma.organization.create({
      data: { name: `Beta ${key}_x Corp`, slug: `b-${randomUUID()}` },
    });
    const gamma = await prisma.organization.create({
      data: { name: `Gamma ${key}%y Corp`, slug: `g-${randomUUID()}` },
    });
    await join(user.id, alpha.id, "USER");
    await join(user.id, beta.id, "USER");
    const cookie = await cookieFor(user);

    const own = await call("get", `/organizations?search=${key}`, cookie);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ page: 1, pageSize: 20, total: 2 });
    expect(own.body.organizations.map((o: { id: string }) => o.id)).toEqual([
      alpha.id,
      beta.id,
    ]);
    expect(own.body.organizations[0]).toEqual({
      id: alpha.id,
      name: alpha.name,
      slug: alpha.slug,
      description: null,
      enabled: true,
      createdAt: alpha.createdAt.toISOString(),
    });

    const all = await call(
      "get",
      `/organizations?search=${key.toUpperCase()}`,
      platformCookie,
    );
    expect(all.body.total).toBe(3);
    expect(all.body.organizations.map((o: { id: string }) => o.id)).toEqual([
      alpha.id,
      beta.id,
      gamma.id,
    ]);

    // `_` and `%` match literally, never as wildcards.
    const underscore = await call(
      "get",
      `/organizations?search=${encodeURIComponent(`${key}_x`)}`,
      platformCookie,
    );
    expect(underscore.body.total).toBe(1);
    const wildcard = await call(
      "get",
      `/organizations?search=${encodeURIComponent(`${key}_`)}`,
      platformCookie,
    );
    expect(wildcard.body.total).toBe(1);
    const percent = await call(
      "get",
      `/organizations?search=${encodeURIComponent("%")}`,
      cookie,
    );
    expect(percent.body.total).toBe(0);
    const percentPlatform = await call(
      "get",
      `/organizations?search=${encodeURIComponent(`${key}%y`)}`,
      platformCookie,
    );
    expect(percentPlatform.body.total).toBe(1);

    const page2 = await call(
      "get",
      `/organizations?search=${key}&page=2&pageSize=1`,
      platformCookie,
    );
    expect(page2.body.total).toBe(3);
    expect(page2.body.organizations.map((o: { id: string }) => o.id)).toEqual([
      beta.id,
    ]);

    const outsider = await call(
      "get",
      `/organizations?search=${key}`,
      await cookieFor(await makeUser()),
    );
    expect(outsider.body).toMatchObject({ organizations: [], total: 0 });
    expect(
      (await call("get", "/organizations?pageSize=101", cookie)).status,
    ).toBe(400);
  });
});

describe("AC-09 GET /users/{userId}", () => {
  async function sharedScenario() {
    const orgA = await makeOrg(`shared-a-${token()}`);
    const orgB = await makeOrg(`shared-b-${token()}`);
    const orgC = await makeOrg(`shared-c-${token()}`);
    const viewer = await makeUser("Vera Viewer");
    const peer = await makeUser("Pablo Peer");
    const stranger = await makeUser("Sam Stranger");
    await join(viewer.id, orgA.id, "USER");
    await join(viewer.id, orgB.id, "ADMIN");
    await join(peer.id, orgA.id, "USER");
    await join(peer.id, orgB.id, "USER");
    await join(peer.id, orgC.id, "USER");
    await join(stranger.id, orgC.id, "USER");
    // Emails are unique among users: one per scenario.
    const peerEmail = `pablo.${randomUUID()}@example.test`;
    await setEmail(peer.id, peerEmail);
    return {
      peerEmail,
      orgA,
      orgB,
      orgC,
      viewer,
      peer,
      stranger,
      viewerCookie: await cookieFor(viewer),
    };
  }

  it("shows a user sharing an organization, with only the shared organizations", async () => {
    const s = await sharedScenario();
    await setLastActive(s.peer.id, 1);
    const response = await call("get", `/users/${s.peer.id}`, s.viewerCookie);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      user: {
        id: s.peer.id,
        name: "Pablo Peer",
        email: s.peerEmail,
        recentlyActive: true,
      },
      sharedOrganizations: [
        { id: s.orgA.id, name: s.orgA.name },
        { id: s.orgB.id, name: s.orgB.name },
      ].sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
    });
    const serialized = JSON.stringify(response.body);
    for (const forbidden of [
      "rut",
      s.peer.rawRut,
      "disabledAt",
      "lastActiveAt",
      "mustChangePassword",
      "role",
      "permissions",
      "passwordHash",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("shows the caller to itself and answers an indistinguishable 404 for strangers and missing users", async () => {
    const s = await sharedScenario();
    const self = await call("get", `/users/${s.viewer.id}`, s.viewerCookie);
    expect(self.status).toBe(200);
    expect(self.body.user.id).toBe(s.viewer.id);
    expect(self.body.sharedOrganizations).toHaveLength(2);

    const stranger = await call(
      "get",
      `/users/${s.stranger.id}`,
      s.viewerCookie,
    );
    const missing = await call("get", `/users/${MISSING}`, s.viewerCookie);
    expect(stranger.status).toBe(404);
    expect(stranger.body.error.code).toBe("NOT_FOUND");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(stranger.body);
    // Control: a peer is visible through the same route.
    expect(
      (await call("get", `/users/${s.peer.id}`, s.viewerCookie)).status,
    ).toBe(200);
  });

  it("lets the platform administrator see any user with the organizations the target belongs to", async () => {
    const s = await sharedScenario();
    const response = await call(
      "get",
      `/users/${s.stranger.id}`,
      platformCookie,
    );
    expect(response.status).toBe(200);
    expect(response.body.sharedOrganizations).toEqual([
      { id: s.orgC.id, name: s.orgC.name },
    ]);
    const loner = await makeUser("Lone User");
    const none = await call("get", `/users/${loner.id}`, platformCookie);
    expect(none.status).toBe(200);
    expect(none.body.sharedOrganizations).toEqual([]);
    expect(
      (await call("get", `/users/${MISSING}`, platformCookie)).status,
    ).toBe(404);
  });

  it("keeps a disabled target visible with recentlyActive false", async () => {
    const s = await sharedScenario();
    await setLastActive(s.peer.id, 1);
    await disableDirectly(s.peer.id);
    const response = await call("get", `/users/${s.peer.id}`, s.viewerCookie);
    expect(response.status).toBe(200);
    expect(response.body.user.recentlyActive).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain("disabled");
  });

  it("requires a session and a completed onboarding", async () => {
    const s = await sharedScenario();
    expect(
      (await call("get", `/users/${s.peer.id}`, s.viewerCookie)).status,
    ).toBe(200);
    expect((await call("get", `/users/${s.peer.id}`, undefined)).status).toBe(
      401,
    );
  });
});

describe("NUL characters in search terms (CR-304)", () => {
  // PostgreSQL text cannot hold U+0000: a term with one used to reach the
  // database and surface as a 500. It is a plain validation error instead.
  it.each([["%00"], ["ada%00lovelace"], ["%00ada"]])(
    "rejects ?search=%s on every search endpoint with 400 VALIDATION_ERROR",
    async (term) => {
      const org = await makeOrg(`nul-${token()}`);
      for (const path of [
        `/admin/users?search=${term}`,
        `/organizations?search=${term}`,
        `/organizations/${org.id}/users?search=${term}`,
      ]) {
        const response = await call("get", path, platformCookie);
        expect(response.status, path).toBe(400);
        expect(response.body.error.code, path).toBe("VALIDATION_ERROR");
      }
    },
  );
});

describe("path ids that are not UUIDs (CR-306)", () => {
  // The frontend treats such ids as "not found" without calling the API and
  // its test transport mirrors what the server answers here.
  it("answers 404 NOT_FOUND, never a 400 or a 500", async () => {
    const org = await makeOrg(`malformed-${token()}`);
    for (const path of [
      "/organizations/org-1",
      "/organizations/org-1/users",
      `/organizations/${org.id}/groups/group-a/memberships`,
      `/organizations/${org.id}/memberships/user-1`,
      "/admin/users/user-1",
      "/users/user-1",
    ]) {
      const response = await call("get", path, platformCookie);
      expect(response.status, path).toBe(404);
      expect(response.body.error.code, path).toBe("NOT_FOUND");
    }
  });
});
