import { afterAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createDatabase } from "../../src/database.js";
import { loadExpectedMigrations } from "../../src/migrations.js";
import request from "../support/request.js";
import { recoveryTestDatabaseUrl } from "./recovery-target.js";

const url = recoveryTestDatabaseUrl();
const applied = loadExpectedMigrations();

const upToDate = createDatabase(url, { expectedMigrations: applied });
const behind = createDatabase(url, {
  expectedMigrations: [...applied, "99991231235959_not_applied_yet"],
});

afterAll(async () => {
  await upToDate.close();
  await behind.close();
});

describe("GET /health/ready against a migrated database", () => {
  it("is 200 when every migration of the build is applied", async () => {
    const response = await request(createApp(upToDate)).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("is 503 MIGRATIONS_PENDING when the build expects a newer migration", async () => {
    const response = await request(createApp(behind)).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: "unavailable",
      code: "MIGRATIONS_PENDING",
    });
    expect(JSON.stringify(response.body)).not.toContain("99991231235959");
  });

  it("only checks connectivity when no expected list is given", async () => {
    const plain = createDatabase(url);
    try {
      expect(await plain.readiness()).toBe("ready");
    } finally {
      await plain.close();
    }
  });
});
