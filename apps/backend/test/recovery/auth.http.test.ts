import request from "../support/request.js";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthRateLimiter } from "../../src/auth-rate-limit.js";
import { AuthError, type AuthService } from "../../src/auth.js";

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };

const profile = {
  id: "user-1",
  name: "Ada",
  rut: "123456785",
  email: null,
  username: null,
  mustChangePassword: false,
  isPlatformAdministrator: false,
  memberships: [],
};

function fakeAuth(overrides: Partial<AuthService> = {}): AuthService {
  return {
    async login() {
      return {
        sessionToken: "opaque-session-token",
        user: { id: "user-1", name: "Ada", rut: "123456785" },
      };
    },
    async logout() {},
    async getProfile() {
      return profile;
    },
    async updateProfile() {
      return profile;
    },
    async changePassword() {
      return { sessionToken: "rotated-session-token" };
    },
    ...overrides,
  };
}

const buildApp = (auth: AuthService = fakeAuth()) =>
  createApp({ isReady: async () => true }, auth);

describe("RP0-04 mixed and Bearer credentials", () => {
  it.each(["Bearer abc", "Basic YTpi", "Token xyz"])(
    "rejects %j together with a session cookie as 400 AMBIGUOUS_AUTH",
    async (header) => {
      const getProfile = vi.fn(async () => profile);
      const response = await request(buildApp(fakeAuth({ getProfile })))
        .get("/api/v1/auth/profile")
        .set("Authorization", header)
        .set("Cookie", COOKIE);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("AMBIGUOUS_AUTH");
      expect(getProfile).not.toHaveBeenCalled();
    },
  );

  it("rejects mixed credentials before the Origin check on writes", async () => {
    const response = await request(buildApp())
      .post("/api/v1/auth/logout")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://evil.example")
      .set("Authorization", "Bearer abc")
      .set("Cookie", COOKIE);

    expect(response.body.error.code).toBe("AMBIGUOUS_AUTH");
  });

  it("answers Bearer alone with 401 and never falls back to a cookie session", async () => {
    const getProfile = vi.fn(async () => profile);
    const response = await request(buildApp(fakeAuth({ getProfile })))
      .get("/api/v1/auth/profile")
      .set("Authorization", "Bearer abc");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(getProfile).not.toHaveBeenCalled();
  });
});

describe("RP0-04 onboarding gate", () => {
  const pending = fakeAuth({
    async getProfile() {
      return { ...profile, mustChangePassword: true };
    },
  });

  it.each([
    ["get", "/api/v1/groups"],
    ["get", "/api/v1/invoices"],
    ["get", "/api/v1/business-policies"],
    ["get", "/api/v1/organizations"],
    ["post", "/api/v1/organizations/o-1/users"],
    ["get", "/api/v1/organizations/o-1/groups"],
  ] as const)("blocks %s %s with ONBOARDING_REQUIRED", async (method, path) => {
    const agent = request(buildApp(pending));
    const response = await agent[method](path)
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ONBOARDING_REQUIRED");
  });

  it("still serves profile, change-password and logout", async () => {
    const app = buildApp(pending);
    const read = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", COOKIE);
    const change = await request(app)
      .post("/api/v1/auth/change-password")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send({
        currentPassword: "temporary",
        newPassword: "changed-password-1",
      });
    const logout = await request(app)
      .post("/api/v1/auth/logout")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);

    expect([read.status, change.status, logout.status]).toEqual([
      200, 204, 204,
    ]);
    expect(read.body.profile.mustChangePassword).toBe(true);
  });
});

describe("RP0-04 change-password response", () => {
  it("sets the rotated session cookie with the login cookie attributes", async () => {
    const app = buildApp();
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ rut: "12.345.678-5", password: "whatever-password" });
    const response = await request(app)
      .post("/api/v1/auth/change-password")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send({
        currentPassword: "temporary",
        newPassword: "changed-password-1",
      });

    expect(response.status).toBe(204);
    const cookie = String(response.headers["set-cookie"]);
    expect(cookie).toContain("invoiceops_session=rotated-session-token");
    const attributes = (value: string) =>
      value
        .split(";")
        .slice(1)
        .map((part) => part.trim().replace(/^Expires=.*/i, "Expires"))
        .sort();
    expect(attributes(cookie)).toEqual(
      attributes(String(login.headers["set-cookie"])),
    );
  });

  it("maps PASSWORD_REUSE to its own code", async () => {
    const response = await request(
      buildApp(
        fakeAuth({
          async changePassword() {
            throw new AuthError(
              400,
              "New password must differ from the current one",
              "PASSWORD_REUSE",
            );
          },
        }),
      ),
    )
      .post("/api/v1/auth/change-password")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send({
        currentPassword: "same-password-1",
        newPassword: "same-password-1",
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("PASSWORD_REUSE");
  });
});

describe("RP0-04 login body edge cases", () => {
  it("pins a literal null body to 400 INVALID_JSON (accepted variance, never 500)", async () => {
    const response = await request(buildApp())
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send("null");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_JSON");
  });
});

describe("RP0-04 login rate limit", () => {
  const failing = fakeAuth({
    async login() {
      throw new AuthError(401, "Invalid credentials");
    },
  });
  const attempt = (app: ReturnType<typeof buildApp>, rut: string, ip = "1") =>
    request(app)
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", ip)
      .send({ rut, password: "wrong-password-1" });

  it("counts only failed attempts", async () => {
    const app = createApp({ isReady: async () => true }, fakeAuth(), {
      authRateLimiter: createAuthRateLimiter({ maxAttempts: 2 }),
    });

    for (let index = 0; index < 5; index += 1) {
      expect((await attempt(app, "12.345.678-5")).status).toBe(200);
    }
  });

  it("keys failures by client IP and by normalized RUT; either key blocks", async () => {
    const failures: string[] = [];
    const blocked = new Set<string>();
    const app = createApp({ isReady: async () => true }, failing, {
      authRateLimiter: {
        isBlocked: (key) => blocked.has(key),
        recordFailure: (key) => void failures.push(key),
        refund: () => {},
        reset: () => {},
      },
    });

    expect((await attempt(app, "12.345.678-5")).status).toBe(401);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/^ip:/);
    expect(failures[1]).toBe("rut:123456785");

    blocked.add("rut:123456785");
    const sameAccount = await attempt(app, "123456785");
    expect(sameAccount.status).toBe(429);
    expect(sameAccount.body.error.code).toBe("RATE_LIMITED");
    // Another account is unaffected by that account's key.
    expect((await attempt(app, "11.111.111-1")).status).toBe(401);

    blocked.add(failures[0]);
    expect((await attempt(app, "11.111.111-1")).status).toBe(429);
  });
});
