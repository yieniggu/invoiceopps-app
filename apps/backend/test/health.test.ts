import request from "supertest";
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
