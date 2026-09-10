import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { createAuthRateLimiter } from "../src/auth-rate-limit.js";
import { AuthError, createAuthService, type AuthService } from "../src/auth.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";

function createAuthServiceForHttpTest(): AuthService {
  const users = new Map<
    string,
    { id: string; name: string; password: string; rut: string }
  >();

  return {
    async signUp({ name, rut, password }) {
      const normalizedRut = rut.replace(/[.\-\s]/g, "");
      const user = { id: "user-1", name, password, rut: normalizedRut };
      users.set(normalizedRut, user);

      return { id: user.id, name: user.name, rut: user.rut };
    },
    async login({ rut, password }) {
      const user = users.get(rut.replace(/[.\-\s]/g, ""));

      if (!user || user.password !== password) {
        throw new AuthError(401, "Invalid credentials");
      }

      return {
        sessionToken: "opaque-session-token",
        user: { id: user.id, name: user.name, rut: user.rut },
      };
    },
  };
}

describe("APP-02 auth HTTP contract", () => {
  it("signs up successfully and logs in with an httpOnly cookie session without a JSON token", async () => {
    const app = createApp(
      { isReady: async () => true },
      createAuthServiceForHttpTest(),
    );
    const credentials = {
      name: "Ada Lovelace",
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    };

    const signupResponse = await request(app)
      .post("/auth/signup")
      .send(credentials);
    const loginResponse = await request(app)
      .post("/auth/login")
      .send({ rut: credentials.rut, password: credentials.password });

    expect.soft(signupResponse.status).toBe(201);
    expect.soft(loginResponse.status).toBe(200);
    expect
      .soft(
        (loginResponse.headers["set-cookie"] ?? []).some((cookie) =>
          /;\s*HttpOnly(?:;|$)/i.test(cookie),
        ),
      )
      .toBe(true);
    expect(loginResponse.headers["set-cookie"]?.[0]).toMatch(/SameSite=Lax/i);
    expect(loginResponse.body).not.toHaveProperty("token");
    expect(JSON.stringify(signupResponse.body)).not.toContain(
      credentials.password,
    );
    expect(JSON.stringify(loginResponse.body)).not.toContain(
      credentials.password,
    );
    expect(JSON.stringify(loginResponse.body)).not.toContain(
      "opaque-session-token",
    );
  });

  it("returns the same generic response for unknown RUTs and invalid passwords", async () => {
    const app = createApp(
      { isReady: async () => true },
      createAuthServiceForHttpTest(),
    );
    await request(app).post("/auth/signup").send({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    });

    const unknownUser = await request(app).post("/auth/login").send({
      rut: "11.111.111-1",
      password: "correct-horse-battery-staple",
    });
    const invalidPassword = await request(app).post("/auth/login").send({
      rut: "12.345.678-5",
      password: "not-the-correct-password",
    });

    expect(unknownUser.status).toBe(401);
    expect(invalidPassword.status).toBe(401);
    expect(unknownUser.body).toEqual(invalidPassword.body);
  });

  it("limits auth attempts from one origin and recovers after its window", async () => {
    let currentTime = 0;
    const app = createApp(
      { isReady: async () => true },
      createAuthServiceForHttpTest(),
      {
        authRateLimiter: createAuthRateLimiter({
          maxAttempts: 2,
          now: () => currentTime,
          windowMs: 1_000,
        }),
      },
    );

    const failedLogin = () =>
      request(app).post("/auth/login").send({
        rut: "12.345.678-5",
        password: "not-the-correct-password",
      });

    expect((await failedLogin()).status).toBe(401);
    expect((await failedLogin()).status).toBe(401);
    const limitedResponse = await request(app).post("/auth/signup").send({
      name: "Ada Lovelace",
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    });

    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.body).toEqual({
      status: "error",
      message: "Too many attempts. Try again later.",
    });

    currentTime += 1_000;
    expect((await failedLogin()).status).toBe(401);
  });

  it("verifies absent and null password hashes before rejecting credentials", async () => {
    const verifiedHashes: string[] = [];
    const passwordVerifier = async (
      _password: string,
      passwordHash: string,
    ) => {
      verifiedHashes.push(passwordHash);
      return false;
    };

    for (const user of [null, { passwordHash: null }]) {
      const auth = createAuthService(
        {
          user: { findUnique: async () => user },
        } as unknown as PrismaClient,
        "open",
        { verifyPassword: passwordVerifier },
      );

      await expect(
        auth.login({
          rut: "12.345.678-5",
          password: "correct-horse-battery-staple",
        }),
      ).rejects.toEqual(new AuthError(401, "Invalid credentials"));
    }

    expect(verifiedHashes).toHaveLength(2);
    expect(verifiedHashes[0]).toBe(verifiedHashes[1]);
  });
});
