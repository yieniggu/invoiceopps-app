import { createHash, randomInt, randomUUID } from "node:crypto";
import pg from "pg";
import request from "../support/request.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { AuthError, createAuthService, hashPassword } from "../../src/auth.js";
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
const lockClient = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const HOUR = 3_600_000;

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

async function createUser(
  password: string,
  options: { temporaryExpiresInMs?: number } = {},
) {
  const rut = randomRut();
  const temporary = options.temporaryExpiresInMs !== undefined;
  const user = await prisma.user.create({
    data: {
      name: "Test User",
      rut,
      passwordHash: await hashPassword(password),
      mustChangePassword: temporary,
      temporaryPasswordExpiresAt: temporary
        ? new Date(Date.now() + options.temporaryExpiresInMs!)
        : null,
    },
    select: { id: true, rut: true },
  });
  return { id: user.id, rut: formatRut(user.rut) };
}

async function sessionCount(userId: string) {
  return prisma.session.count({ where: { userId } });
}

// Backend pid of lockClient, the only holder of the row lock these tests
// create; waiters are identified by being blocked (directly or in queue) by
// exactly that backend, so
// unrelated lock waits (other files, other statements) can never satisfy it.
let lockPid = 0;

async function waitForLockWaiters(count: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let waiting = 0;
  for (;;) {
    // Directly blocked by the holder, or queued behind a waiter that is.
    const result = await client.query(
      `WITH RECURSIVE chain(pid) AS (
         SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a JOIN chain c
           ON c.pid = ANY(pg_blocking_pids(a.pid))
         WHERE a.datname = current_database()
       )
       SELECT count(*)::int AS n FROM chain`,
      [lockPid],
    );
    waiting = result.rows[0].n as number;
    if (waiting >= count) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Expected ${count} backend(s) blocked by the test lock holder, saw ${waiting} after ${timeoutMs} ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function holdUserLock(userId: string) {
  await lockClient.query("BEGIN");
  await lockClient.query('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', [
    userId,
  ]);
}

beforeAll(async () => {
  await client.connect();
  await lockClient.connect();
  lockPid = (await lockClient.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid as number;
});
afterAll(async () => {
  await client.end();
  await lockClient.end();
  await prisma.$disconnect();
});

describe("RP0-04 profile contexts", () => {
  it("lists only enabled organizations with both memberships, using group flags", async () => {
    const user = await createUser("correct-horse-battery");
    const mk = (name: string, enabled = true) =>
      prisma.organization.create({
        data: { name, slug: `${name}-${randomUUID()}`, enabled },
      });
    const [orgA, orgDisabled, orgNoMembership] = [
      await mk("Alpha"),
      await mk("Disabled", false),
      await mk("NoMembership"),
    ];
    for (const org of [orgA, orgDisabled]) {
      await prisma.organizationMembership.create({
        data: { userId: user.id, organizationId: org.id, role: "USER" },
      });
    }
    const group = (
      organizationId: string,
      name: string,
      flags: Record<string, boolean> = {},
    ) => prisma.group.create({ data: { organizationId, name, ...flags } });
    const readCreate = await group(orgA.id, "Beta", {
      readInvoices: true,
      createInvoices: true,
    });
    const deleters = await group(orgA.id, "Alpha group", {
      deleteOwnInvoices: true,
      deleteOthersInvoices: true,
    });
    const notJoined = await group(orgA.id, "Not joined", {
      readInvoices: true,
    });
    const inDisabled = await group(orgDisabled.id, "Hidden", {
      readInvoices: true,
    });
    const noOrgMembership = await group(orgNoMembership.id, "Orphan", {
      readInvoices: true,
    });
    for (const g of [readCreate, deleters, inDisabled]) {
      await prisma.groupMembership.create({
        data: {
          groupId: g.id,
          userId: user.id,
          organizationId: g.organizationId,
        },
      });
    }
    // Group membership without organization membership is impossible through
    // the FK; the group simply stays out of the contexts.
    expect(notJoined.id).not.toBe(noOrgMembership.id);

    const login = await auth.login({
      rut: user.rut,
      password: "correct-horse-battery",
    });
    const profile = await auth.getProfile(login.sessionToken);

    expect(profile.contexts).toEqual([
      {
        organizationId: orgA.id,
        organizationName: "Alpha",
        groupId: deleters.id,
        groupName: "Alpha group",
        capabilities: {
          readInvoices: false,
          createInvoices: false,
          deleteOwnInvoices: true,
          deleteOthersInvoices: true,
        },
      },
      {
        organizationId: orgA.id,
        organizationName: "Alpha",
        groupId: readCreate.id,
        groupName: "Beta",
        capabilities: {
          readInvoices: true,
          createInvoices: true,
          deleteOwnInvoices: false,
          deleteOthersInvoices: false,
        },
      },
    ]);
  });
});

describe("RP0-04 session expiry while onboarding", () => {
  it("caps the session at the temporary password expiry", async () => {
    const soon = await createUser("temporary-password-1", {
      temporaryExpiresInMs: 2 * HOUR,
    });
    const far = await createUser("temporary-password-2", {
      temporaryExpiresInMs: 240 * HOUR,
    });
    const regular = await createUser("regular-password-123");

    const sessions = [];
    for (const [user, password] of [
      [soon, "temporary-password-1"],
      [far, "temporary-password-2"],
      [regular, "regular-password-123"],
    ] as const) {
      await auth.login({ rut: user.rut, password });
      sessions.push(
        await prisma.session.findFirstOrThrow({ where: { userId: user.id } }),
      );
    }

    const remaining = sessions.map(
      (session) => (session.expiresAt.getTime() - Date.now()) / HOUR,
    );
    expect(remaining[0]).toBeGreaterThan(1.9);
    expect(remaining[0]).toBeLessThanOrEqual(2);
    expect(remaining[1]).toBeGreaterThan(167.9);
    expect(remaining[1]).toBeLessThanOrEqual(168);
    expect(remaining[2]).toBeGreaterThan(167.9);
    expect(remaining[2]).toBeLessThanOrEqual(168);
  });
});

describe("RP0-04 change-password over HTTP", () => {
  it("rejects reuse, then rotates the session and revokes tokens", async () => {
    const user = await createUser("temporary-password-1", {
      temporaryExpiresInMs: 2 * HOUR,
    });
    const organization = await prisma.organization.create({
      data: { name: "Org", slug: `org-${randomUUID()}` },
    });
    await prisma.organizationMembership.create({
      data: { userId: user.id, organizationId: organization.id, role: "USER" },
    });
    const group = await prisma.group.create({
      data: { organizationId: organization.id, name: "G" },
    });
    await prisma.groupMembership.create({
      data: {
        groupId: group.id,
        userId: user.id,
        organizationId: organization.id,
      },
    });
    const alreadyRevoked = new Date(Date.now() - HOUR);
    const tokenData = (revokedAt: Date | null) => ({
      userId: user.id,
      name: "t",
      organizationId: organization.id,
      groupId: group.id,
      tokenHash: randomUUID(),
      scopes: ["INVOICES_READ" as const],
      expiresAt: new Date(Date.now() + 24 * HOUR),
      revokedAt,
    });
    const active = await prisma.apiToken.create({ data: tokenData(null) });
    const revoked = await prisma.apiToken.create({
      data: tokenData(alreadyRevoked),
    });
    const app = createApp(database, auth);

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ rut: user.rut, password: "temporary-password-1" });
    const oldCookie = String(login.headers["set-cookie"]).split(";")[0];
    await request(app)
      .post("/api/v1/auth/login")
      .send({ rut: user.rut, password: "temporary-password-1" });
    expect(await sessionCount(user.id)).toBe(2);

    const reuse = await request(app)
      .post("/api/v1/auth/change-password")
      .set(SAME_ORIGIN)
      .set("Cookie", oldCookie)
      .send({
        currentPassword: "temporary-password-1",
        newPassword: "temporary-password-1",
      });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe("PASSWORD_REUSE");
    expect(await sessionCount(user.id)).toBe(2);

    const changed = await request(app)
      .post("/api/v1/auth/change-password")
      .set(SAME_ORIGIN)
      .set("Cookie", oldCookie)
      .send({
        currentPassword: "temporary-password-1",
        newPassword: "a-different-password-9",
      });
    expect(changed.status).toBe(204);
    const setCookie = String(changed.headers["set-cookie"]);
    expect(setCookie).toMatch(/invoiceops_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    const newCookie = setCookie.split(";")[0];
    expect(newCookie).not.toBe(oldCookie);

    expect(
      (await request(app).get("/api/v1/auth/profile").set("Cookie", oldCookie))
        .status,
    ).toBe(401);
    const profile = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", newCookie);
    expect(profile.status).toBe(200);
    expect(profile.body.profile.mustChangePassword).toBe(false);
    expect(await sessionCount(user.id)).toBe(1);

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { mustChangePassword: true, temporaryPasswordExpiresAt: true },
    });
    expect(stored).toEqual({
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
    });
    const tokens = await prisma.apiToken.findMany({
      where: { userId: user.id },
      orderBy: { id: "asc" },
    });
    const byId = new Map(tokens.map((token) => [token.id, token]));
    expect(byId.get(active.id)?.revokedAt).toBeInstanceOf(Date);
    expect(byId.get(revoked.id)?.revokedAt?.getTime()).toBe(
      alreadyRevoked.getTime(),
    );
    expect(
      await prisma.platformAdministrativeAuditEvent.count({
        where: { type: "PASSWORD_CHANGED", targetUserId: user.id },
      }),
    ).toBe(1);
  });
});

describe("RP0-04 credential serialization", () => {
  it("refuses a login whose password changed while it waited for the user lock", async () => {
    const user = await createUser("original-password-1");
    const newHash = await hashPassword("replaced-password-2");
    await holdUserLock(user.id);

    const login = auth
      .login({ rut: user.rut, password: "original-password-1" })
      .then(
        () => "created" as const,
        (error: unknown) => error,
      );
    await waitForLockWaiters(1);
    await lockClient.query(
      'UPDATE "User" SET "passwordHash" = $1 WHERE id = $2',
      [newHash, user.id],
    );
    await lockClient.query("COMMIT");

    const outcome = await login;
    expect(outcome).toBeInstanceOf(AuthError);
    expect((outcome as AuthError).status).toBe(401);
    expect(await sessionCount(user.id)).toBe(0);
  });

  it("lets exactly one of two concurrent password changes win", async () => {
    const user = await createUser("original-password-1");
    const { sessionToken } = await auth.login({
      rut: user.rut,
      password: "original-password-1",
    });
    await holdUserLock(user.id);

    const attempt = (newPassword: string) =>
      auth.changePassword!(sessionToken, {
        currentPassword: "original-password-1",
        newPassword,
      }).then(
        (result) => ({ ok: true as const, result, newPassword }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const first = attempt("first-new-password-1");
    const second = attempt("second-new-password-2");
    await waitForLockWaiters(2);
    await lockClient.query("COMMIT");
    const outcomes = await Promise.all([first, second]);

    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(
      [401, 400].includes((losers[0] as { error: AuthError }).error.status),
    ).toBe(true);

    const winner = winners[0] as {
      result: { sessionToken: string };
      newPassword: string;
    };
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(stored.passwordHash).toBeTruthy();
    // The final credential is exactly the winner's password.
    await expect(
      auth.login({ rut: user.rut, password: winner.newPassword }),
    ).resolves.toBeDefined();
    const sessions = await prisma.session.findMany({
      where: { userId: user.id },
    });
    const winnerHash = createHash("sha256")
      .update(winner.result.sessionToken)
      .digest("base64");
    // Only the winner's rotated session plus the verification login above.
    expect(sessions.map((session) => session.tokenHash)).toContain(winnerHash);
    expect(sessions).toHaveLength(2);
    // The original session never revives.
    await expect(auth.getProfile(sessionToken)).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});
