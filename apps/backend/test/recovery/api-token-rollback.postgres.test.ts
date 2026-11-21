import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
const app = createApp(database, auth, {});
const { scenario } = membershipFixtures({ prisma, client, auth, app, url });

beforeAll(async () => {
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});

/** The SQL block of the pre-rollback step, exactly as DEPLOY.md documents it. */
function documentedPreRollbackSql() {
  const deploy = readFileSync(resolve("../../DEPLOY.md"), "utf8");
  const match = /<<'SQL'\n(BEGIN;[\s\S]*?COMMIT;)\nSQL\n/.exec(deploy);
  if (!match?.[1]) throw new Error("DEPLOY.md lost the pre-rollback SQL block");
  return match[1];
}

describe("rollback past 20261101 (CR-521)", () => {
  it("the documented SQL removes every ApiToken with mlflow scopes and keeps the others", async () => {
    const s = await scenario();
    const make = (name: string, scopes: string[], revoked = false) =>
      client.query(
        `INSERT INTO "ApiToken" (id, "userId", name, "organizationId", "tokenHash", scopes, "expiresAt", "revokedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::"ApiTokenScope"[], now() + interval '1 day', $6)`,
        [
          s.member.id,
          name,
          s.org.id,
          `hash-${name}-${Date.now()}`,
          scopes,
          revoked ? new Date() : null,
        ],
      );
    await make("rb-mlflow", ["mlflow:read"]);
    await make("rb-mlflow-revoked", ["mlflow:write"], true);
    await make("rb-mixed", ["invoices:read", "mlflow:read"]);
    await make("rb-invoices", ["invoices:read", "invoices:create"]);

    const before = await client.query(
      `SELECT name FROM "ApiToken" WHERE name LIKE 'rb-%' ORDER BY name`,
    );
    expect(before.rows.map((row) => row.name)).toEqual([
      "rb-invoices",
      "rb-mixed",
      "rb-mlflow",
      "rb-mlflow-revoked",
    ]);

    await client.query(documentedPreRollbackSql());

    const after = await client.query(
      `SELECT name FROM "ApiToken" WHERE name LIKE 'rb-%' ORDER BY name`,
    );
    expect(after.rows.map((row) => row.name)).toEqual(["rb-invoices"]);
    // What the previous release can still read: no mlflow value remains.
    const leftover = await client.query(
      `SELECT count(*)::int AS n FROM "ApiToken"
       WHERE scopes && ARRAY['mlflow:read','mlflow:write']::"ApiTokenScope"[]`,
    );
    expect(leftover.rows[0].n).toBe(0);
  });
});
