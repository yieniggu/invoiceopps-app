import request from "./support/request.js";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("health endpoints", () => {
  it("returns liveness without querying the database", async () => {
    const app = createApp({
      isReady: async () => {
        throw new Error("The liveness endpoint must not query the database");
      },
    });

    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("returns ready when the database is reachable", async () => {
    const app = createApp({ isReady: async () => true });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("returns a safe 503 response when the database is unavailable", async () => {
    const app = createApp({
      isReady: async () => {
        throw new Error("Database connection refused");
      },
    });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "unavailable" });
  });
});

describe("readiness with pending migrations", () => {
  it("returns 503 MIGRATIONS_PENDING without exposing details", async () => {
    const app = createApp({
      isReady: async () => true,
      readiness: async () => "migrations_pending",
    });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: "unavailable",
      code: "MIGRATIONS_PENDING",
    });
  });

  it("returns ready when the rich probe says so", async () => {
    const app = createApp({
      isReady: async () => false,
      readiness: async () => "ready",
    });

    expect((await request(app).get("/health/ready")).status).toBe(200);
  });

  it("returns the plain 503 when the rich probe is unavailable or throws", async () => {
    for (const readiness of [
      async () => "unavailable" as const,
      async () => {
        throw new Error("boom");
      },
    ]) {
      const app = createApp({ isReady: async () => true, readiness });
      const response = await request(app).get("/health/ready");
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ status: "unavailable" });
    }
  });
});
