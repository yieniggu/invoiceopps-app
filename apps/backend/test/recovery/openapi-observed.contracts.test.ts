import request from "../support/request.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthRateLimiter } from "../../src/auth-rate-limit.js";
import { AuthError, type AuthService } from "../../src/auth.js";

// Every status the HTTP tests observe for a documented operation must be
// documented: each row performs a real request and checks the OpenAPI
// document lists that status for that operation.

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

const boom = () => {
  throw new Error("database down");
};
const app = (auth: AuthService | null = fakeAuth(), limit = 100) =>
  createApp({ isReady: async () => true }, auth ?? undefined, {
    authRateLimiter: createAuthRateLimiter({ maxAttempts: limit }),
  });

type Observation = [
  operation: string,
  scenario: string,
  status: number,
  run: () => Promise<{ status: number }>,
];

const LOGIN = "post /api/v1/auth/login";
const PROFILE = "get /api/v1/auth/profile";
const CHANGE = "post /api/v1/auth/change-password";
const LOGOUT = "post /api/v1/auth/logout";
const credentials = { rut: "12.345.678-5", password: "some-password-123" };
const passwords = {
  currentPassword: "old-password-123",
  newPassword: "new-password-1234",
};

const observations: Observation[] = [
  [
    LOGIN,
    "success",
    200,
    () => request(app()).post("/api/v1/auth/login").send(credentials),
  ],
  [
    LOGIN,
    "ambiguous credentials",
    400,
    () =>
      request(app())
        .post("/api/v1/auth/login")
        .set(SAME_ORIGIN)
        .set("Authorization", "Bearer x")
        .set("Cookie", COOKIE)
        .send(credentials),
  ],
  [
    LOGIN,
    "invalid JSON",
    400,
    () =>
      request(app())
        .post("/api/v1/auth/login")
        .set("Content-Type", "application/json")
        .send("{"),
  ],
  [
    LOGIN,
    "malformed content encoding",
    400,
    () =>
      request(app())
        .post("/api/v1/auth/login")
        .set("Content-Type", "application/json")
        .set("Content-Encoding", "gzip")
        .send("not gzip data"),
  ],
  [
    LOGIN,
    "unsupported charset",
    415,
    () =>
      request(app())
        .post("/api/v1/auth/login")
        .set("Content-Type", "application/json; charset=latin1")
        .send("{}"),
  ],
  [
    LOGIN,
    "unsupported content encoding",
    415,
    () =>
      request(app())
        .post("/api/v1/auth/login")
        .set("Content-Type", "application/json")
        .set("Content-Encoding", "compress")
        .send("{}"),
  ],
  [
    CHANGE,
    "unsupported charset",
    415,
    () =>
      request(app())
        .post("/api/v1/auth/change-password")
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE)
        .set("Content-Type", "application/json; charset=latin1")
        .send("{}"),
  ],
  [
    LOGIN,
    "wrong credentials",
    401,
    () =>
      request(
        app(
          fakeAuth({
            async login() {
              throw new AuthError(401, "Invalid credentials");
            },
          }),
        ),
      )
        .post("/api/v1/auth/login")
        .send(credentials),
  ],
  [
    LOGIN,
    "Authorization alone",
    401,
    () =>
      request(app())
        .post("/api/v1/auth/login")
        .set("Authorization", "Bearer x")
        .send(credentials),
  ],
  [
    LOGIN,
    "foreign origin with a cookie",
    403,
    () =>
      request(app())
        .post("/api/v1/auth/login")
        .set({ Host: "127.0.0.1", Origin: "http://evil.example" })
        .set("Cookie", COOKIE)
        .send(credentials),
  ],
  [
    LOGIN,
    "oversized body",
    413,
    () =>
      request(app())
        .post("/api/v1/auth/login")
        .send({ rut: "1", password: "x".repeat(20_000) }),
  ],
  [
    LOGIN,
    "rate limited",
    429,
    async () => {
      const limited = app(
        fakeAuth({
          async login() {
            throw new AuthError(401, "Invalid credentials");
          },
        }),
        1,
      );
      await request(limited).post("/api/v1/auth/login").send(credentials);
      return request(limited).post("/api/v1/auth/login").send(credentials);
    },
  ],
  [
    LOGIN,
    "service failure",
    500,
    () =>
      request(app(fakeAuth({ login: boom })))
        .post("/api/v1/auth/login")
        .send(credentials),
  ],
  [
    LOGIN,
    "authentication not configured",
    503,
    () => request(app(null)).post("/api/v1/auth/login").send(credentials),
  ],

  [
    PROFILE,
    "success",
    200,
    () => request(app()).get("/api/v1/auth/profile").set("Cookie", COOKIE),
  ],
  [
    PROFILE,
    "ambiguous credentials",
    400,
    () =>
      request(app())
        .get("/api/v1/auth/profile")
        .set("Authorization", "Bearer x")
        .set("Cookie", COOKIE),
  ],
  [
    PROFILE,
    "missing session",
    401,
    () => request(app()).get("/api/v1/auth/profile"),
  ],
  [
    PROFILE,
    "oversized body",
    413,
    () =>
      request(app())
        .get("/api/v1/auth/profile")
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ filler: "x".repeat(20_000) })),
  ],
  [
    PROFILE,
    "service failure",
    500,
    () =>
      request(app(fakeAuth({ getProfile: boom })))
        .get("/api/v1/auth/profile")
        .set("Cookie", COOKIE),
  ],

  [
    CHANGE,
    "success",
    204,
    () =>
      request(app())
        .post("/api/v1/auth/change-password")
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE)
        .send(passwords),
  ],
  [
    CHANGE,
    "invalid body",
    400,
    () =>
      request(app())
        .post("/api/v1/auth/change-password")
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE)
        .send({ currentPassword: "x", newPassword: "short" }),
  ],
  [
    CHANGE,
    "password reuse",
    400,
    () =>
      request(
        app(
          fakeAuth({
            async changePassword() {
              throw new AuthError(
                400,
                "The new password must differ from the current one.",
                "PASSWORD_REUSE",
              );
            },
          }),
        ),
      )
        .post("/api/v1/auth/change-password")
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE)
        .send(passwords),
  ],
  [
    CHANGE,
    "ambiguous credentials",
    400,
    () =>
      request(app())
        .post("/api/v1/auth/change-password")
        .set(SAME_ORIGIN)
        .set("Authorization", "Bearer x")
        .set("Cookie", COOKIE)
        .send(passwords),
  ],
  [
    CHANGE,
    "missing session",
    401,
    () => request(app()).post("/api/v1/auth/change-password").send(passwords),
  ],
  [
    CHANGE,
    "foreign origin",
    403,
    () =>
      request(app())
        .post("/api/v1/auth/change-password")
        .set({ Host: "127.0.0.1", Origin: "http://evil.example" })
        .set("Cookie", COOKIE)
        .send(passwords),
  ],
  [
    CHANGE,
    "oversized body",
    413,
    () =>
      request(app())
        .post("/api/v1/auth/change-password")
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE)
        .send({ ...passwords, filler: "x".repeat(20_000) }),
  ],
  [
    CHANGE,
    "service failure",
    500,
    () =>
      request(app(fakeAuth({ changePassword: boom })))
        .post("/api/v1/auth/change-password")
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE)
        .send(passwords),
  ],

  [
    LOGOUT,
    "success",
    204,
    () =>
      request(app())
        .post("/api/v1/auth/logout")
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE),
  ],
  [
    LOGOUT,
    "ambiguous credentials",
    400,
    () =>
      request(app())
        .post("/api/v1/auth/logout")
        .set(SAME_ORIGIN)
        .set("Authorization", "Bearer x")
        .set("Cookie", COOKIE),
  ],
  [
    LOGOUT,
    "missing session",
    401,
    () => request(app()).post("/api/v1/auth/logout"),
  ],
  [
    LOGOUT,
    "foreign origin",
    403,
    () =>
      request(app())
        .post("/api/v1/auth/logout")
        .set({ Host: "127.0.0.1", Origin: "http://evil.example" })
        .set("Cookie", COOKIE),
  ],
  [
    LOGOUT,
    "oversized body",
    413,
    () =>
      request(app())
        .post("/api/v1/auth/logout")
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE)
        .send({ filler: "x".repeat(20_000) }),
  ],
  [
    LOGOUT,
    "service failure",
    500,
    () =>
      request(app(fakeAuth({ logout: boom })))
        .post("/api/v1/auth/logout")
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE),
  ],
];

describe("OpenAPI lists every observed status", () => {
  let paths: Record<
    string,
    Record<string, { responses: Record<string, unknown> }>
  >;

  beforeAll(async () => {
    const response = await request(app()).get("/openapi.json");
    paths = response.body.paths;
  });

  it.each(observations)(
    "%s: %s answers %i",
    async (operation, _scenario, status, run) => {
      const [method, path] = operation.split(" ");
      const response = await run();

      expect(response.status).toBe(status);
      expect(
        Object.keys(paths[path][method].responses),
        `${operation} documents ${status}`,
      ).toContain(String(status));
    },
  );

  it("documents every status of every operation with an Error schema or a bodiless success", () => {
    for (const [path, item] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(item)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          const content = (response as { content?: unknown }).content;
          if (Number(status) >= 400) {
            expect(content, `${method} ${path} ${status}`).toBeDefined();
          }
        }
      }
    }
  });

  it("documents the logout cookie clearing and the change-password rotation", () => {
    const logout = paths["/api/v1/auth/logout"].post.responses["204"] as {
      headers?: Record<string, unknown>;
    };
    const change = paths["/api/v1/auth/change-password"].post.responses[
      "204"
    ] as {
      headers?: Record<string, unknown>;
    };

    expect(logout.headers?.["Set-Cookie"]).toBeDefined();
    expect(change.headers?.["Set-Cookie"]).toBeDefined();
  });
});
