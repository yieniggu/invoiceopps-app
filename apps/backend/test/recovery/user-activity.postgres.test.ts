import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthService } from "../../src/auth.js";
import { createDatabase } from "../../src/database.js";
import { membershipFixtures } from "./membership-fixtures.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

const url = recoveryTestDatabaseUrl();

const client = new pg.Client({ connectionString: url });
const database = createDatabase(url);
const prisma = database.prisma;
const auth = createAuthService(prisma);
const app = createApp(database, auth);
const { makeUser, cookieFor, call } = membershipFixtures({
  prisma,
  client,
  auth,
  app,
  url,
});

beforeAll(async () => {
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

// Prisma stores DateTime as UTC wall-clock time in a timestamp column, while
// node-postgres would read and write it in the host time zone. Computing in SQL
// against UTC keeps the tests independent of the host TZ.
const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;

// Raw text so an unchanged value compares exactly.
async function lastActiveAtText(userId: string) {
  const result = await client.query(
    'SELECT "lastActiveAt"::text AS value FROM "User" WHERE id = $1',
    [userId],
  );
  return result.rows[0].value as string | null;
}

async function secondsSinceLastActive(userId: string) {
  const result = await client.query(
    `SELECT EXTRACT(EPOCH FROM ${UTC_NOW} - "lastActiveAt")::float AS seconds
     FROM "User" WHERE id = $1`,
    [userId],
  );
  return result.rows[0].seconds as number | null;
}

async function setLastActiveMinutesAgo(userId: string, minutes: number) {
  await client.query(
    `UPDATE "User" SET "lastActiveAt" = ${UTC_NOW} - make_interval(mins => $2)
     WHERE id = $1`,
    [userId, minutes],
  );
}

// The activity write is fire-and-forget: poll until the observed value holds.
async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean) {
  let value = await read();
  for (let attempt = 0; attempt < 50 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
}

describe("AC-21 recent activity tracking", () => {
  it("records activity on login", async () => {
    const user = await makeUser("Activity Login");

    await cookieFor(user);

    const seconds = await secondsSinceLastActive(user.id);
    expect(seconds).not.toBeNull();
    expect(Math.abs(seconds!)).toBeLessThan(60);
  });

  it("refreshes activity on an authenticated request when it is older than five minutes", async () => {
    const user = await makeUser("Activity Stale");
    const cookie = await cookieFor(user);
    await setLastActiveMinutesAgo(user.id, 10);

    expect((await call("get", "/auth/profile", cookie)).status).toBe(200);

    const seconds = await eventually(
      () => secondsSinceLastActive(user.id),
      (value) => value !== null && Math.abs(value) < 60,
    );
    expect(seconds).not.toBeNull();
    expect(Math.abs(seconds!)).toBeLessThan(60);
  });

  it("does not wait for the activity write to answer the profile", async () => {
    const user = await makeUser("Activity Unblocked");
    const cookie = await cookieFor(user);
    await setLastActiveMinutesAgo(user.id, 10);
    // Holding the user row lock blocks the activity UPDATE; the profile must
    // still answer.
    await client.query("BEGIN");
    try {
      await client.query('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', [
        user.id,
      ]);
      const answered = await Promise.race([
        call("get", "/auth/profile", cookie).then((r) => r.status),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("blocked"), 3000),
        ),
      ]);
      expect(answered).toBe(200);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("does not write activity for a user disabled after the session was read", async () => {
    const user = await makeUser("Activity Disabled");
    const cookie = await cookieFor(user);
    await setLastActiveMinutesAgo(user.id, 10);
    const stale = await lastActiveAtText(user.id);
    const writes: Promise<unknown>[] = [];
    // Disables the user right after the profile read and before the write.
    const racing = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === "session") {
          return {
            findUnique: async (args: never) => {
              const found = await target.session.findUnique(args);
              await client.query(
                `UPDATE "User" SET "disabledAt" = ${UTC_NOW} WHERE id = $1`,
                [user.id],
              );
              return found;
            },
          };
        }
        if (property === "user") {
          return {
            updateMany: (args: never) => {
              const write = target.user.updateMany(args);
              writes.push(write);
              return write;
            },
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const service = createAuthService(racing);

    await service.getProfile(cookie.slice(cookie.indexOf("=") + 1));
    await eventually(
      async () => writes.length,
      (count) => count > 0,
    );
    await Promise.all(writes);

    expect(await lastActiveAtText(user.id)).toBe(stale);
  });

  it("does not write activity again within five minutes", async () => {
    const user = await makeUser("Activity Fresh");
    const cookie = await cookieFor(user);
    // Control: login recorded activity, so the column is live.
    expect(await lastActiveAtText(user.id)).not.toBeNull();
    await setLastActiveMinutesAgo(user.id, 2);
    const recent = await lastActiveAtText(user.id);

    expect((await call("get", "/auth/profile", cookie)).status).toBe(200);

    expect(await lastActiveAtText(user.id)).toBe(recent);
  });

  it("does not record activity for a failed login", async () => {
    const user = await makeUser("Activity Failed");
    // Control: a successful login records activity, so the column is live.
    await cookieFor(user);
    await setLastActiveMinutesAgo(user.id, 30);
    const earlier = await lastActiveAtText(user.id);

    await expect(
      auth.login({ rut: user.rut, password: "wrong-password-123" }),
    ).rejects.toThrow();

    expect(await lastActiveAtText(user.id)).toBe(earlier);
  });
});
