import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { ApiError } from "../../src/http/errors.js";
import { createMlflowSsoService } from "../../src/features/mlflow-sso/service.js";
import { PASSWORD, membershipFixtures } from "./membership-fixtures.js";
import { waitFor } from "../support/wait-for.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

const url = recoveryTestDatabaseUrl();
const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const app = createApp(database, auth, {
  internalServiceSecret: "m".repeat(48),
  mlflowCallbackUrl: "https://mlflow.example.test/_gateway/callback",
});
const sso = createMlflowSsoService(prisma);
const { call, scenario: plainScenario } = membershipFixtures({
  prisma,
  client,
  auth,
  app,
  url,
});

// MLflow access is part of the Models section (mlEnabled): these suites run
// with the organization's section on; the "off" cases set it back explicitly.
const scenario = async () => {
  const s = await plainScenario();
  await prisma.organization.update({
    where: { id: s.org.id },
    data: { mlEnabled: true },
  });
  return s;
};

beforeAll(async () => {
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

// The Prisma pg adapter pools at most 10 connections and every logout or
// exchange holds one for its whole transaction. Starting more concurrent
// operations than the pool has only measures queueing (P2028 after maxWait),
// not the lock order under test, so the rounds run in waves that fit the pool.
const POOL_SIZE = 10;
const OPERATIONS_PER_ROUND = 4; // one logout + three exchanges of the same code
const ROUNDS_IN_FLIGHT = Math.floor((POOL_SIZE - 2) / OPERATIONS_PER_ROUND);

const PASSWORD_LOGIN = (rut: string) => auth.login({ rut, password: PASSWORD });

describe("MLflow handoff: exchange racing logout", () => {
  it("never deadlocks: every logout answers 204 and no child survives", async () => {
    const s = await scenario();
    const ROUNDS = 24;
    const rounds = [];
    for (let index = 0; index < ROUNDS; index += 1) {
      const { sessionToken } = await PASSWORD_LOGIN(s.member.rut);
      const issued = await sso.authorize(sessionToken);
      if (issued.status !== "issued") throw new Error("expected a code");
      rounds.push({ sessionToken, code: issued.code });
    }

    // Within a wave, everything of every round starts at once: several
    // exchanges of the same code and the logout of its parent session.
    const outcomes: {
      logout: PromiseSettledResult<{ status: number }>;
      exchanges: PromiseSettledResult<unknown>[];
    }[] = [];
    for (let from = 0; from < rounds.length; from += ROUNDS_IN_FLIGHT) {
      const wave = await Promise.all(
        rounds
          .slice(from, from + ROUNDS_IN_FLIGHT)
          .map(async ({ sessionToken, code }) => {
            const [logout, ...exchanges] = await Promise.allSettled([
              call(
                "post",
                "/auth/logout",
                `invoiceops_session=${sessionToken}`,
              ),
              sso.exchange(code),
              sso.exchange(code),
              sso.exchange(code),
            ]);
            return { logout, exchanges };
          }),
      );
      outcomes.push(...wave);
    }

    for (const { logout, exchanges } of outcomes) {
      expect(logout.status).toBe("fulfilled");
      if (logout.status === "fulfilled") expect(logout.value.status).toBe(204);
      for (const exchange of exchanges) {
        // An exchange either won (a token) or lost (null); it never errors.
        // The only tolerated failure is the explicit retryable 503 of a
        // transaction that could not start in time (P2028), never a deadlock.
        if (exchange.status === "rejected") {
          expect(exchange.reason).toBeInstanceOf(ApiError);
          expect(exchange.reason).toMatchObject({
            status: 503,
            code: "RETRYABLE_CONFLICT",
          });
        }
      }
    }
    const sessionIds = await prisma.session.count({
      where: { userId: s.member.id },
    });
    expect(sessionIds).toBe(0);
    expect(
      await prisma.mlflowSession.count({ where: { userId: s.member.id } }),
    ).toBe(0);
    expect(
      await prisma.mlflowHandoffCode.count({ where: { userId: s.member.id } }),
    ).toBe(0);
  }, 120_000);

  it("takes the parent session lock before the code row (forced interleaving)", async () => {
    // A logout is mid-flight: it holds the Session row and has not yet cascaded
    // to the code. An exchange that claimed the code first and only then
    // reached the Session (the old order) would sit on the code row and make
    // the cascade wait for it: a lock cycle that Postgres resolves by killing
    // one side. With the Session lock taken first the exchange just waits.
    const s = await scenario();
    const { sessionToken } = await PASSWORD_LOGIN(s.member.rut);
    const issued = await sso.authorize(sessionToken);
    if (issued.status !== "issued") throw new Error("expected a code");
    const parent = await prisma.session.findFirstOrThrow({
      where: { userId: s.member.id },
    });
    const logout = new pg.Client({ connectionString: url });
    await logout.connect();
    try {
      await logout.query("BEGIN");
      await logout.query('SELECT id FROM "Session" WHERE id = $1 FOR UPDATE', [
        parent.id,
      ]);
      const { rows } = await logout.query("SELECT pg_backend_pid() AS pid");
      const logoutPid = rows[0].pid as number;
      const exchange = sso.exchange(issued.code);
      // Deterministic: proceed only once the exchange is observed waiting on
      // the Session row lock that the logout holds (not on the code row).
      await waitFor(async () => {
        const waiting = await client.query(
          `SELECT 1
             FROM pg_locks l
             JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE a.datname = current_database()
              AND NOT l.granted
              AND $1::int = ANY(pg_blocking_pids(l.pid))
              AND a.query ILIKE '%"Session"%'
            LIMIT 1`,
          [logoutPid],
        );
        return waiting.rowCount === 1;
      }, "the exchange to wait on the Session row lock held by the logout");
      await logout.query('DELETE FROM "Session" WHERE id = $1', [parent.id]);
      await logout.query("COMMIT");

      expect(await exchange).toBeNull();
    } finally {
      await logout.query("ROLLBACK").catch(() => {});
      await logout.end();
    }
    expect(
      await prisma.mlflowSession.count({ where: { sessionId: parent.id } }),
    ).toBe(0);
  }, 30_000);

  it("refuses an exchange whose parent session is already gone", async () => {
    const s = await scenario();
    const { sessionToken } = await PASSWORD_LOGIN(s.member.rut);
    const issued = await sso.authorize(sessionToken);
    if (issued.status !== "issued") throw new Error("expected a code");
    await auth.logout(sessionToken);

    expect(await sso.exchange(issued.code)).toBeNull();
  });

  it("prunes expired child sessions when a new code is issued", async () => {
    const s = await scenario();
    const { sessionToken } = await PASSWORD_LOGIN(s.member.rut);
    const parent = await prisma.session.findFirstOrThrow({
      where: { userId: s.member.id },
    });
    const expired = await prisma.mlflowSession.create({
      data: {
        tokenHash: `expired-${Date.now()}`,
        userId: s.member.id,
        sessionId: parent.id,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const live = await prisma.mlflowSession.create({
      data: {
        tokenHash: `live-${Date.now()}`,
        userId: s.member.id,
        sessionId: parent.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await sso.authorize(sessionToken);

    expect(
      await prisma.mlflowSession.findUnique({ where: { id: expired.id } }),
    ).toBeNull();
    expect(
      await prisma.mlflowSession.findUnique({ where: { id: live.id } }),
    ).not.toBeNull();
  });
});
