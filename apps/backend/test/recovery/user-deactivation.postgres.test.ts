import { randomUUID } from "node:crypto";
import pg from "pg";
import request from "../support/request.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import {
  membershipFixtures,
  PASSWORD,
  SAME_ORIGIN,
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

const deactivate = (userId: string, cookie: string | undefined) =>
  call("post", `/admin/users/${userId}/deactivation`, cookie);
const reactivate = (userId: string, cookie: string | undefined) =>
  call("delete", `/admin/users/${userId}/deactivation`, cookie);

// Raw SQL on purpose: the Prisma client does not know "disabledAt" yet.
async function disabledAtOf(userId: string) {
  const result = await client.query(
    'SELECT "disabledAt" FROM "User" WHERE id = $1',
    [userId],
  );
  return result.rows[0].disabledAt as Date | null;
}

async function sessionCount(userId: string) {
  const result = await client.query(
    'SELECT count(*)::int AS n FROM "Session" WHERE "userId" = $1',
    [userId],
  );
  return result.rows[0].n as number;
}

async function auditCount(type: string, targetUserId: string) {
  const result = await client.query(
    `SELECT count(*)::int AS n FROM "PlatformAdministrativeAuditEvent"
     WHERE type::text = $1 AND "targetUserId" = $2`,
    [type, targetUserId],
  );
  return result.rows[0].n as number;
}

async function seedToken(userId: string, organizationId: string) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "ApiToken" ("id","userId","name","organizationId","tokenHash","scopes","expiresAt")
     VALUES ($1,$2,'t',$3,$4,ARRAY['invoices:read']::"ApiTokenScope"[],now() + interval '1 day')`,
    [id, userId, organizationId, `hash-${id}`],
  );
  return id;
}

async function memberOf(label: string) {
  const org = await makeOrg(label);
  const user = await makeUser(`Member ${label}`);
  await join(user.id, org.id, "USER");
  const spareAdmin = await makeUser(`Spare ${label}`);
  await join(spareAdmin.id, org.id, "ADMIN");
  return { org, user, spareAdmin };
}

describe("AC-05 POST/DELETE /api/v1/admin/users/{userId}/deactivation authority and conflicts", () => {
  it("deactivates a user and returns {id,name,rut,disabledAt} with an ISO datetime", async () => {
    const { user } = await memberOf("ac05-ok");

    const response = await deactivate(user.id, platformCookie);

    expect(response.status).toBe(200);
    expect(Object.keys(response.body)).toEqual(["user"]);
    expect(response.body.user).toMatchObject({
      id: user.id,
      name: "Member ac05-ok",
    });
    expect(typeof response.body.user.rut).toBe("string");
    expect(new Date(response.body.user.disabledAt).toISOString()).toBe(
      response.body.user.disabledAt,
    );
    expect(await disabledAtOf(user.id)).not.toBeNull();
  });

  it("reactivates the user and returns disabledAt null", async () => {
    const { user } = await memberOf("ac05-react");
    await deactivate(user.id, platformCookie);

    const response = await reactivate(user.id, platformCookie);

    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: user.id, disabledAt: null });
    expect(await disabledAtOf(user.id)).toBeNull();
  });

  it("answers 401 without a session and 403 FORBIDDEN for an organization ADMIN and a USER", async () => {
    const { org, user, spareAdmin } = await memberOf("ac05-authz");
    const plainUser = await makeUser();
    await join(plainUser.id, org.id, "USER");

    const anonymous = await deactivate(user.id, undefined);
    const orgAdmin = await deactivate(user.id, await cookieFor(spareAdmin));
    const orgUser = await deactivate(user.id, await cookieFor(plainUser));
    const orgAdminReactivate = await reactivate(
      user.id,
      await cookieFor(spareAdmin),
    );

    expect(anonymous.status).toBe(401);
    expect(orgAdmin.status).toBe(403);
    expect(orgAdmin.body.error.code).toBe("FORBIDDEN");
    expect(orgUser.status).toBe(403);
    expect(orgUser.body.error.code).toBe("FORBIDDEN");
    expect(orgAdminReactivate.status).toBe(403);
    expect(await disabledAtOf(user.id)).toBeNull();
  });

  it("answers 403 ONBOARDING_REQUIRED while the platform administrator still has a temporary password", async () => {
    const { user } = await memberOf("ac05-onb");
    await client.query(
      `UPDATE "User" SET "mustChangePassword" = true WHERE id = $1`,
      [platform.id],
    );
    try {
      const response = await deactivate(user.id, platformCookie);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("ONBOARDING_REQUIRED");
    } finally {
      await client.query(
        `UPDATE "User" SET "mustChangePassword" = false WHERE id = $1`,
        [platform.id],
      );
    }
  });

  it("rejects a cross-origin write", async () => {
    const { user } = await memberOf("ac05-csrf");
    const response = await request(app)
      .post(`/api/v1/admin/users/${user.id}/deactivation`)
      .set({ Host: "127.0.0.1", Origin: "http://evil.example" })
      .set("Cookie", platformCookie);
    expect(response.status).toBe(403);
    expect(await disabledAtOf(user.id)).toBeNull();
  });

  it("answers 404 NOT_FOUND for an unknown user", async () => {
    // Control: the route exists, so the 404 below is about the user.
    const { user } = await memberOf("ac05-missing-control");
    expect((await deactivate(user.id, platformCookie)).status).toBe(200);

    const missing = randomUUID();
    const down = await deactivate(missing, platformCookie);
    const up = await reactivate(missing, platformCookie);
    expect(down.status).toBe(404);
    expect(down.body.error.code).toBe("NOT_FOUND");
    expect(up.status).toBe(404);
    expect(up.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 409 SELF_ACTION_FORBIDDEN when the actor targets themselves", async () => {
    const response = await deactivate(platform.id, platformCookie);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("SELF_ACTION_FORBIDDEN");
  });

  it("answers 409 LAST_ADMIN_REQUIRED when the target is the last enabled ADMIN of an organization", async () => {
    const org = await makeOrg("ac05-last");
    const soleAdmin = await makeUser("Sole Admin");
    await join(soleAdmin.id, org.id, "ADMIN");

    const response = await deactivate(soleAdmin.id, platformCookie);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("LAST_ADMIN_REQUIRED");
    expect(await disabledAtOf(soleAdmin.id)).toBeNull();
  });

  it("answers 409 LAST_ADMIN_REQUIRED when the only other ADMIN is already disabled", async () => {
    const org = await makeOrg("ac05-last2");
    const first = await makeUser("First Admin");
    const second = await makeUser("Second Admin");
    await join(first.id, org.id, "ADMIN");
    await join(second.id, org.id, "ADMIN");
    expect((await deactivate(first.id, platformCookie)).status).toBe(200);

    const response = await deactivate(second.id, platformCookie);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("LAST_ADMIN_REQUIRED");
  });

  it("is idempotent: repeating either action returns 200 without a change or an extra audit row", async () => {
    const { user } = await memberOf("ac05-idem");

    const noopReactivate = await reactivate(user.id, platformCookie);
    expect(noopReactivate.status).toBe(200);
    expect(await auditCount("USER_REACTIVATED", user.id)).toBe(0);

    const first = await deactivate(user.id, platformCookie);
    const stamp = await disabledAtOf(user.id);
    const second = await deactivate(user.id, platformCookie);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.user.disabledAt).toBe(first.body.user.disabledAt);
    expect(await disabledAtOf(user.id)).toEqual(stamp);
    expect(await auditCount("USER_DEACTIVATED", user.id)).toBe(1);

    await reactivate(user.id, platformCookie);
    const again = await reactivate(user.id, platformCookie);
    expect(again.status).toBe(200);
    expect(await auditCount("USER_REACTIVATED", user.id)).toBe(1);
  });
});

describe("AC-06 disabled user behavior", () => {
  it("deletes every session and revokes active API tokens on deactivation", async () => {
    const { org, user } = await memberOf("ac06-sessions");
    await cookieFor(user);
    await cookieFor(user);
    const tokenId = await seedToken(user.id, org.id);
    const alreadyRevoked = await seedToken(user.id, org.id);
    await client.query(
      `UPDATE "ApiToken" SET "revokedAt" = '2020-01-01T00:00:00Z' WHERE id = $1`,
      [alreadyRevoked],
    );
    expect(await sessionCount(user.id)).toBe(2);

    expect((await deactivate(user.id, platformCookie)).status).toBe(200);

    expect(await sessionCount(user.id)).toBe(0);
    // Raw text: node-postgres would reinterpret the timestamp in the host TZ.
    const tokens = await client.query(
      'SELECT id, "revokedAt"::text AS "revokedAt" FROM "ApiToken" WHERE "userId" = $1',
      [user.id],
    );
    const byId = new Map(tokens.rows.map((row) => [row.id, row.revokedAt]));
    expect(byId.get(tokenId)).not.toBeNull();
    expect(byId.get(alreadyRevoked)).toBe("2020-01-01 00:00:00");
  });

  it("answers a disabled user's login with exactly the invalid-credentials 401", async () => {
    const { user } = await memberOf("ac06-login");
    await deactivate(user.id, platformCookie);

    const disabled = await request(app)
      .post("/api/v1/auth/login")
      .set(SAME_ORIGIN)
      .send({ rut: user.rut, password: PASSWORD });
    const wrong = await request(app)
      .post("/api/v1/auth/login")
      .set(SAME_ORIGIN)
      .send({ rut: user.rut, password: "definitely-not-the-password" });

    expect(wrong.status).toBe(401);
    expect(disabled.status).toBe(wrong.status);
    expect(disabled.body).toEqual(wrong.body);
    expect(disabled.headers["set-cookie"]).toBeUndefined();
  });

  it("answers 401 UNAUTHENTICATED to a cookie issued before the deactivation", async () => {
    const { user } = await memberOf("ac06-cookie");
    const cookie = await cookieFor(user);
    expect((await call("get", "/auth/profile", cookie)).status).toBe(200);

    await deactivate(user.id, platformCookie);
    const profile = await call("get", "/auth/profile", cookie);

    expect(profile.status).toBe(401);
    expect(profile.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("keeps every membership while disabled", async () => {
    const { org, user } = await memberOf("ac06-memberships");
    expect((await deactivate(user.id, platformCookie)).status).toBe(200);
    expect(await disabledAtOf(user.id)).not.toBeNull();
    const count = await prisma.organizationMembership.count({
      where: { userId: user.id, organizationId: org.id },
    });
    expect(count).toBe(1);
  });

  it("lets the user log in again after reactivation without restoring old sessions", async () => {
    const { user } = await memberOf("ac06-react");
    const oldCookie = await cookieFor(user);
    await deactivate(user.id, platformCookie);

    expect((await reactivate(user.id, platformCookie)).status).toBe(200);
    expect(await sessionCount(user.id)).toBe(0);
    expect((await call("get", "/auth/profile", oldCookie)).status).toBe(401);

    const fresh = await cookieFor(user);
    expect((await call("get", "/auth/profile", fresh)).status).toBe(200);
  });
});

describe("AC-05 last enabled ADMIN on role change and removal", () => {
  // The only other ADMIN is disabled, so the remaining enabled ADMIN cannot be
  // demoted or removed: the organization would keep no administrator who can act.
  async function orgWithDisabledCoAdmin(label: string) {
    const org = await makeOrg(label);
    const enabled = await makeUser(`Enabled ${label}`);
    const disabled = await makeUser(`Disabled ${label}`);
    await join(enabled.id, org.id, "ADMIN");
    await join(disabled.id, org.id, "ADMIN");
    expect((await deactivate(disabled.id, platformCookie)).status).toBe(200);
    return { org, enabled };
  }

  it("refuses to demote the last enabled ADMIN", async () => {
    const { org, enabled } = await orgWithDisabledCoAdmin("ac05-demote");
    const response = await call(
      "patch",
      `/organizations/${org.id}/memberships/${enabled.id}`,
      platformCookie,
      { role: "USER" },
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("LAST_ADMIN_REQUIRED");
  });

  it("refuses to remove the last enabled ADMIN", async () => {
    const { org, enabled } = await orgWithDisabledCoAdmin("ac05-remove");
    const response = await call(
      "delete",
      `/organizations/${org.id}/memberships/${enabled.id}`,
      platformCookie,
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("LAST_ADMIN_REQUIRED");
  });
});

describe("AC-07 deactivation racing with login", () => {
  it("never leaves a live session for a disabled user", async () => {
    for (let round = 0; round < 15; round += 1) {
      const { user } = await memberOf(`ac07-${round}`);
      await Promise.allSettled([
        auth.login({ rut: user.rut, password: PASSWORD }),
        auth.login({ rut: user.rut, password: PASSWORD }),
        deactivate(user.id, platformCookie),
      ]);
      const disabledAt = await disabledAtOf(user.id);
      expect(disabledAt).not.toBeNull();
      expect(await sessionCount(user.id)).toBe(0);
    }
  });
});

describe("AC-05 last enabled ADMIN under concurrency", () => {
  async function enabledAdmins(organizationId: string) {
    const result = await client.query(
      `SELECT count(*)::int AS n FROM "OrganizationMembership" m
       JOIN "User" u ON u.id = m."userId"
       WHERE m."organizationId" = $1 AND m.role = 'ADMIN' AND u."disabledAt" IS NULL`,
      [organizationId],
    );
    return result.rows[0].n as number;
  }

  interface Outcome {
    status: number;
    body: { error?: { code: string } };
  }

  // The lock wait may legitimately give up with a retryable 503 (documented
  // contract); the caller then tries again with a small backoff, exactly as a
  // client would (up to 3 attempts in total).
  async function withRetry(operation: () => PromiseLike<Outcome>) {
    let outcome = await operation();
    for (const delayMs of [25, 50]) {
      if (outcome.status !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      outcome = await operation();
    }
    return outcome;
  }

  // 200 (deactivation) and 204 (membership removal) are successes.
  const isSuccess = ({ status }: Outcome) => [200, 204].includes(status);

  // A race between two requests that would each remove the last enabled ADMIN
  // must let exactly one through; the other is refused with LAST_ADMIN_REQUIRED.
  // An all-503 round would pass "at least one ADMIN is left" without proving
  // anything, so it fails here.
  function expectExactlyOneWinner(outcomes: Outcome[]) {
    expect(outcomes.filter(isSuccess)).toHaveLength(1);
    const loser = outcomes.find((outcome) => !isSuccess(outcome))!;
    expect(loser.status).toBe(409);
    expect(loser.body.error?.code).toBe("LAST_ADMIN_REQUIRED");
  }

  it("keeps an enabled ADMIN when two co-admins are deactivated together", async () => {
    for (let round = 0; round < 10; round += 1) {
      const org = await makeOrg(`ac05-pair-${round}`);
      const first = await makeUser(`Pair A ${round}`);
      const second = await makeUser(`Pair B ${round}`);
      await join(first.id, org.id, "ADMIN");
      await join(second.id, org.id, "ADMIN");

      const outcomes = await Promise.all([
        withRetry(() => deactivate(first.id, platformCookie)),
        withRetry(() => deactivate(second.id, platformCookie)),
      ]);

      expectExactlyOneWinner(outcomes);
      expect(await enabledAdmins(org.id)).toBe(1);
    }
  });

  it("keeps an enabled ADMIN when one is deactivated while the other is demoted or removed", async () => {
    for (let round = 0; round < 10; round += 1) {
      const org = await makeOrg(`ac05-mixed-${round}`);
      const first = await makeUser(`Mixed A ${round}`);
      const second = await makeUser(`Mixed B ${round}`);
      await join(first.id, org.id, "ADMIN");
      await join(second.id, org.id, "ADMIN");
      const change = () =>
        round % 2 === 0
          ? call(
              "patch",
              `/organizations/${org.id}/memberships/${second.id}`,
              platformCookie,
              { role: "USER" },
            )
          : call(
              "delete",
              `/organizations/${org.id}/memberships/${second.id}`,
              platformCookie,
            );

      const outcomes = await Promise.all([
        withRetry(() => deactivate(first.id, platformCookie)),
        withRetry(change),
      ]);

      expectExactlyOneWinner(outcomes);
      expect(await enabledAdmins(org.id)).toBe(1);
    }
  });
});

describe("AC-11 audit", () => {
  it("writes USER_DEACTIVATED and USER_REACTIVATED with actor and target ids only", async () => {
    const { user } = await memberOf("ac11");

    await deactivate(user.id, platformCookie);
    await reactivate(user.id, platformCookie);

    const rows = await client.query(
      `SELECT type::text AS type, "actorUserId", "targetUserId", "organizationId", "groupId"
       FROM "PlatformAdministrativeAuditEvent"
       WHERE "targetUserId" = $1 AND type::text IN ('USER_DEACTIVATED','USER_REACTIVATED')
       ORDER BY "createdAt", id`,
      [user.id],
    );
    expect(rows.rows.map((row) => row.type).sort()).toEqual([
      "USER_DEACTIVATED",
      "USER_REACTIVATED",
    ]);
    for (const row of rows.rows) {
      expect(row).toMatchObject({
        actorUserId: platform.id,
        targetUserId: user.id,
        organizationId: null,
        groupId: null,
      });
    }
  });

  it("writes no audit row for a rejected action", async () => {
    const org = await makeOrg("ac11-rejected");
    const soleAdmin = await makeUser("Sole Admin");
    await join(soleAdmin.id, org.id, "ADMIN");
    expect((await deactivate(soleAdmin.id, platformCookie)).status).toBe(409);
    expect(await auditCount("USER_DEACTIVATED", soleAdmin.id)).toBe(0);
  });
});
