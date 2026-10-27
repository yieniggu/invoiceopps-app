import request from "../support/request.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { createAuthRateLimiter } from "../../src/auth-rate-limit.js";
import { AuthError, type AuthService } from "../../src/auth.js";
import type {
  GroupCatalogService,
  GroupService,
} from "../../src/features/groups/services.js";
import type { OrganizationService } from "../../src/features/orgs/services.js";

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const RUT = "12.345.678-5";

const profile = {
  id: "user-1",
  name: "Ada",
  rut: "123456785",
  email: null,
  username: null,
  mustChangePassword: false,
  isPlatformAdministrator: true,
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

afterEach(() => {
  vi.restoreAllMocks();
});

function silenceLogs() {
  return {
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

function loggedText(logs: ReturnType<typeof silenceLogs>) {
  return [logs.info, logs.warn, logs.error]
    .flatMap((spy) => spy.mock.calls.flat())
    .map(String)
    .join("\n");
}

describe("CR-003 case and trailing-slash variants of the API prefix", () => {
  it.each([
    "/API/V1/auth/profile",
    "/Api/v1/auth/profile",
    "/api/V1/auth/profile",
    "/api/v1/auth/profile/",
    "/api/v1//auth/profile",
  ])(
    "never serves %s from the cookie when Authorization is also sent",
    async (path) => {
      const getProfile = vi.fn(async () => profile);
      const app = createApp(
        { isReady: async () => true },
        fakeAuth({ getProfile }),
      );

      const response = await request(app)
        .get(path)
        .set("Authorization", "Bearer abc")
        .set("Cookie", COOKIE);

      expect([400, 404]).toContain(response.status);
      expect(response.status).not.toBe(200);
      expect(response.body.error.code).toMatch(/AMBIGUOUS_AUTH|NOT_FOUND/);
      expect(getProfile).not.toHaveBeenCalled();
    },
  );

  it.each(["/API/V1/auth/profile", "/api/v1/auth/profile/"])(
    "answers %s with a plain 404 envelope",
    async (path) => {
      const app = createApp({ isReady: async () => true }, fakeAuth());

      const response = await request(app).get(path).set("Cookie", COOKIE);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    },
  );

  it("does not reach the session layer for a case variant of the prefix", async () => {
    const getProfile = vi.fn(async () => profile);
    const app = createApp(
      { isReady: async () => true },
      fakeAuth({ getProfile }),
    );

    await request(app).get("/API/V1/auth/profile").set("Cookie", COOKIE);

    expect(getProfile).not.toHaveBeenCalled();
  });

  it("keeps the onboarding gate on the exact prefix for case variants", async () => {
    const getProfile = vi.fn(async () => ({
      ...profile,
      mustChangePassword: true,
    }));
    const groups = { listGroups: vi.fn(async () => []) };
    const app = createApp(
      { isReady: async () => true },
      fakeAuth({ getProfile }),
      { groups: groups as unknown as GroupCatalogService },
    );

    const variant = await request(app)
      .get("/API/V1/groups")
      .set("Cookie", COOKIE);
    const exact = await request(app)
      .get("/api/v1/groups")
      .set("Cookie", COOKIE);

    expect(variant.status).toBe(404);
    expect(exact.status).toBe(403);
    expect(groups.listGroups).not.toHaveBeenCalled();
  });
});

describe("CR-005 login attempts are reserved before verification", () => {
  function slowFailingAuth() {
    const login = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new AuthError(401, "Invalid credentials");
    });
    return { login, auth: fakeAuth({ login }) };
  }

  it("lets at most maxAttempts of 20 parallel wrong logins through (same RUT)", async () => {
    silenceLogs();
    const { login, auth } = slowFailingAuth();
    const app = createApp({ isReady: async () => true }, auth, {
      authRateLimiter: createAuthRateLimiter({ maxAttempts: 5 }),
    });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(app)
          .post("/api/v1/auth/login")
          .send({ rut: RUT, password: "wrong-password-1" }),
      ),
    );

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(15);
    expect(login).toHaveBeenCalledTimes(5);
  });

  it("limits one RUT attacked from many client IPs (trust proxy)", async () => {
    silenceLogs();
    const { login, auth } = slowFailingAuth();
    const app = createApp({ isReady: async () => true }, auth, {
      authRateLimiter: createAuthRateLimiter({ maxAttempts: 5 }),
      trustProxyHops: 1,
    });

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        request(app)
          .post("/api/v1/auth/login")
          .set("X-Forwarded-For", `203.0.113.${index + 1}`)
          .send({ rut: RUT, password: "wrong-password-1" }),
      ),
    );

    const statuses = responses.map((response) => response.status);
    // Check and reservation are one synchronous section, so exactly
    // maxAttempts requests reach the credential check whatever the arrival order.
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(15);
    expect(login).toHaveBeenCalledTimes(5);
  });

  it("limits many RUTs attacked from one IP", async () => {
    silenceLogs();
    const { login, auth } = slowFailingAuth();
    const app = createApp({ isReady: async () => true }, auth, {
      authRateLimiter: createAuthRateLimiter({ maxAttempts: 5 }),
    });
    const ruts = [
      "12.345.678-5",
      "11.111.111-1",
      "22.222.222-2",
      "7.654.321-6",
    ];

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        request(app)
          .post("/api/v1/auth/login")
          .send({
            rut: ruts[index % ruts.length],
            password: "wrong-password-1",
          }),
      ),
    );

    const statuses = responses.map((response) => response.status);
    // The shared IP key admits exactly 5 attempts in total, whichever RUTs
    // arrive first.
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(15);
    expect(login).toHaveBeenCalledTimes(5);
  });

  it("gives the reservation back on success and on server errors", async () => {
    silenceLogs();
    let mode: "ok" | "boom" = "ok";
    const auth = fakeAuth({
      async login() {
        if (mode === "boom") throw new Error("database down");
        return {
          sessionToken: "opaque-session-token",
          user: { id: "user-1", name: "Ada", rut: "123456785" },
        };
      },
    });
    const app = createApp({ isReady: async () => true }, auth, {
      authRateLimiter: createAuthRateLimiter({ maxAttempts: 2 }),
    });

    for (let index = 0; index < 6; index += 1) {
      mode = index % 2 === 0 ? "ok" : "boom";
      const response = await request(app)
        .post("/api/v1/auth/login")
        .send({ rut: RUT, password: "right-password-123" });
      expect(response.status).toBe(mode === "ok" ? 200 : 500);
    }
  });

  it("a successful login clears the progressive lock level of the RUT", async () => {
    silenceLogs();
    let now = 0;
    let succeed = false;
    const auth = fakeAuth({
      async login() {
        if (succeed) {
          return {
            sessionToken: "opaque-session-token",
            user: { id: "user-1", name: "Ada", rut: "123456785" },
          };
        }
        throw new AuthError(401, "Invalid credentials");
      },
    });
    const app = createApp({ isReady: async () => true }, auth, {
      authRateLimiter: createAuthRateLimiter({
        maxAttempts: 2,
        now: () => now,
      }),
      trustProxyHops: 1,
    });
    const attempt = (ip: string) =>
      request(app)
        .post("/api/v1/auth/login")
        .set("X-Forwarded-For", ip)
        .send({ rut: RUT, password: "some-password-123" });

    await attempt("198.51.100.1");
    await attempt("198.51.100.2");
    expect((await attempt("198.51.100.3")).status).toBe(429);
    now += 61_000; // first lock (1 minute) is over
    succeed = true;
    expect((await attempt("198.51.100.4")).status).toBe(200);
    succeed = false;
    await attempt("198.51.100.5");
    await attempt("198.51.100.6");
    expect((await attempt("198.51.100.7")).status).toBe(429);
    now += 61_000; // level was reset: the new lock is 1 minute again, not 2
    expect((await attempt("198.51.100.8")).status).toBe(401);
  });
});

describe("CR-006 trusted proxy hops and progressive RUT lockout", () => {
  function keysSeen(options: { trustProxyHops?: number }) {
    const keys: string[] = [];
    const app = createApp(
      { isReady: async () => true },
      fakeAuth({
        async login() {
          throw new AuthError(401, "Invalid credentials");
        },
      }),
      {
        authRateLimiter: {
          isBlocked: () => false,
          recordFailure: (key) => void keys.push(key),
          refund: () => {},
          reset: () => {},
        },
        ...options,
      },
    );
    return { app, keys };
  }

  it("ignores X-Forwarded-For when no proxy is trusted", async () => {
    silenceLogs();
    const { app, keys } = keysSeen({});

    await request(app)
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", "203.0.113.9")
      .send({ rut: RUT, password: "wrong-password-1" });

    expect(keys[0]).toMatch(/^ip:/);
    expect(keys[0]).not.toContain("203.0.113.9");
  });

  it("keys on the client address one trusted hop away", async () => {
    silenceLogs();
    const { app, keys } = keysSeen({ trustProxyHops: 1 });

    await request(app)
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", "203.0.113.9")
      .send({ rut: RUT, password: "wrong-password-1" });

    expect(keys[0]).toBe("ip:203.0.113.9");
  });

  it("takes the right-most untrusted address, not a forged left entry", async () => {
    silenceLogs();
    const { app, keys } = keysSeen({ trustProxyHops: 1 });

    await request(app)
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", "6.6.6.6, 203.0.113.9")
      .send({ rut: RUT, password: "wrong-password-1" });

    expect(keys[0]).toBe("ip:203.0.113.9");
  });

  it("locks a RUT for 1 minute, then 2 minutes, instead of a fixed window", async () => {
    silenceLogs();
    let now = 0;
    const app = createApp(
      { isReady: async () => true },
      fakeAuth({
        async login() {
          throw new AuthError(401, "Invalid credentials");
        },
      }),
      {
        authRateLimiter: createAuthRateLimiter({
          maxAttempts: 2,
          now: () => now,
        }),
        trustProxyHops: 1,
      },
    );
    let counter = 0;
    const attempt = () =>
      request(app)
        .post("/api/v1/auth/login")
        .set("X-Forwarded-For", `198.51.100.${(counter += 1)}`)
        .send({ rut: RUT, password: "some-password-123" });

    await attempt();
    await attempt();
    expect((await attempt()).status).toBe(429);
    now += 59_000;
    expect((await attempt()).status).toBe(429);
    now += 2_000;
    expect((await attempt()).status).toBe(401);
    await attempt();
    expect((await attempt()).status).toBe(429);
    now += 61_000; // the second lock lasts 2 minutes
    expect((await attempt()).status).toBe(429);
    now += 60_000;
    expect((await attempt()).status).toBe(401);
  });
});

describe("CR-010 encoded or path-like identifiers", () => {
  function organizationsApp() {
    const service = {
      createMembership: vi.fn(async () => ({})),
      changeMembershipRole: vi.fn(async () => ({})),
      removeMembership: vi.fn(async () => {}),
      listOrganizations: vi.fn(async () => []),
    };
    const groups = {
      removeMember: vi.fn(async () => {}),
    };
    const app = createApp({ isReady: async () => true }, fakeAuth(), {
      organizations: service as unknown as OrganizationService,
      groupAdministration: groups as unknown as GroupService,
    });
    return { app, service, groups };
  }

  it.each([
    "/api/v1/organizations/o%2Fx/memberships/u",
    "/api/v1/organizations/o%2fx/memberships/u",
    "/api/v1/organizations/o/memberships/u%2Fx",
    "/api/v1/organizations/..%2f/memberships/u",
    "/api/v1/organizations/o/memberships/..%2F..%2Fadmin",
    "/api/v1/organizations/o/memberships/%2e%2e",
    "/api/v1/organizations/o%5Cx/memberships/u",
    "/api/v1/organizations/o/memberships/u/extra",
    "/api/v1/organizations//memberships/u",
    "/api/v1/organizations/o/memberships//u",
  ])("answers DELETE %s with a JSON 404 and calls no service", async (path) => {
    const { app, service } = organizationsApp();

    const response = await request(app)
      .delete(path)
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND", message: expect.any(String) },
    });
    expect(service.removeMembership).not.toHaveBeenCalled();
  });

  it("applies the same guard to group identifiers", async () => {
    const { app, groups } = organizationsApp();

    const response = await request(app)
      .delete("/api/v1/organizations/o/groups/g%2Fx/memberships/u")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);

    expect(response.status).toBe(404);
    expect(groups.removeMember).not.toHaveBeenCalled();
  });

  it("still serves ordinary identifiers", async () => {
    const { app, service } = organizationsApp();

    const response = await request(app)
      .delete("/api/v1/organizations/org-1/memberships/user-2")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);

    expect(response.status).toBe(204);
    expect(service.removeMembership).toHaveBeenCalledWith(
      "user-1",
      "org-1",
      "user-2",
    );
  });
});

describe("CR-012 onboarding gate scope and profile reuse", () => {
  it("answers 404 for unknown root paths even with a stale cookie", async () => {
    const getProfile = vi.fn(async () => {
      throw new AuthError(401, "Unauthenticated");
    });
    const app = createApp(
      { isReady: async () => true },
      fakeAuth({ getProfile }),
    );

    const response = await request(app).get("/random").set("Cookie", COOKIE);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(getProfile).not.toHaveBeenCalled();
  });

  it("resolves the profile once for a profile request", async () => {
    const getProfile = vi.fn(async () => profile);
    const app = createApp(
      { isReady: async () => true },
      fakeAuth({ getProfile }),
    );

    const response = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", COOKIE);

    expect(response.status).toBe(200);
    expect(getProfile).toHaveBeenCalledTimes(1);
  });

  it("resolves the profile once for a gated route (gate result is reused)", async () => {
    const getProfile = vi.fn(async () => profile);
    const groups = { listGroups: vi.fn(async () => []) };
    const app = createApp(
      { isReady: async () => true },
      fakeAuth({ getProfile }),
      { groups: groups as unknown as GroupCatalogService },
    );

    const response = await request(app)
      .get("/api/v1/groups")
      .set("Cookie", COOKIE);

    expect(response.status).toBe(200);
    expect(getProfile).toHaveBeenCalledTimes(1);
  });
});

describe("CR-015 error fields keep a __proto__ key", () => {
  it("reports an unknown __proto__ field over HTTP", async () => {
    const app = createApp({ isReady: async () => true }, fakeAuth());

    const response = await request(app)
      .patch("/api/v1/profile")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .set("Content-Type", "application/json")
      .send('{"__proto__": 1, "email": null}');

    expect(response.status).toBe(400);
    expect(response.text).toContain('"__proto__"');
    expect(Object.hasOwn(response.body.error.fields, "__proto__")).toBe(true);
  });
});

describe("CR-018 structured logs never carry credentials or identifiers", () => {
  const PASSWORD = "very-secret-password-9";

  function events(logs: ReturnType<typeof silenceLogs>) {
    return [logs.info, logs.warn, logs.error]
      .flatMap((spy) => spy.mock.calls.map((call) => String(call[0])))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("logs auth.login_failed as one JSON line without RUT, password or cookie", async () => {
    const logs = silenceLogs();
    const app = createApp(
      { isReady: async () => true },
      fakeAuth({
        async login() {
          throw new AuthError(401, "Invalid credentials");
        },
      }),
    );

    await request(app)
      .post("/api/v1/auth/login?token=query-secret")
      .set(SAME_ORIGIN)
      .set("Cookie", "other=cookie-secret")
      .send({ rut: RUT, password: PASSWORD });

    const [event] = events(logs);
    expect(event).toMatchObject({
      event: "auth.login_failed",
      code: "UNAUTHENTICATED",
      method: "POST",
      route: "/api/v1/auth/login",
      reason: "invalid_credentials",
    });
    const text = loggedText(logs);
    for (const secret of [
      PASSWORD,
      RUT,
      "12345678",
      "query-secret",
      "cookie-secret",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text.trim().split("\n")).toHaveLength(1);
  });

  it("logs auth.rate_limited with the scope that blocked", async () => {
    const logs = silenceLogs();
    const app = createApp(
      { isReady: async () => true },
      fakeAuth({
        async login() {
          throw new AuthError(401, "Invalid credentials");
        },
      }),
      { authRateLimiter: createAuthRateLimiter({ maxAttempts: 1 }) },
    );

    await request(app)
      .post("/api/v1/auth/login")
      .send({ rut: RUT, password: PASSWORD });
    await request(app)
      .post("/api/v1/auth/login")
      .send({ rut: RUT, password: PASSWORD });

    expect(events(logs)).toContainEqual(
      expect.objectContaining({
        event: "auth.rate_limited",
        code: "RATE_LIMITED",
        scope: "ip",
      }),
    );
    expect(loggedText(logs)).not.toContain(PASSWORD);
    expect(loggedText(logs)).not.toContain("12345678");
  });

  it("logs auth.password_changed without the passwords", async () => {
    const logs = silenceLogs();
    const app = createApp({ isReady: async () => true }, fakeAuth());

    await request(app)
      .post("/api/v1/auth/change-password")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send({ currentPassword: "old-password-123", newPassword: PASSWORD });

    expect(events(logs)).toContainEqual(
      expect.objectContaining({
        event: "auth.password_changed",
        route: "/api/v1/auth/change-password",
      }),
    );
    const text = loggedText(logs);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("old-password-123");
    expect(text).not.toContain("session-token");
  });

  it("logs an unexpected 500 with the class and Prisma code only", async () => {
    const logs = silenceLogs();
    const failure = Object.assign(
      new Error(`Unique constraint failed on rut ${RUT} password ${PASSWORD}`),
      { name: "PrismaClientKnownRequestError", code: "P2002" },
    );
    const app = createApp(
      { isReady: async () => true },
      fakeAuth({
        async getProfile() {
          throw failure;
        },
      }),
    );

    const response = await request(app)
      .get("/api/v1/auth/profile?secret=query-secret")
      .set("Cookie", "invoiceops_session=cookie-secret");

    expect(response.status).toBe(500);
    expect(response.body.error.message).toBe("Internal server error");
    expect(events(logs)).toEqual([
      expect.objectContaining({
        event: "http.unhandled_error",
        level: "error",
        code: "INTERNAL_ERROR",
        method: "GET",
        route: "/api/v1/auth/profile",
        errorName: "PrismaClientKnownRequestError",
        prismaCode: "P2002",
      }),
    ]);
    const text = loggedText(logs);
    for (const secret of [
      PASSWORD,
      RUT,
      "query-secret",
      "cookie-secret",
      "Unique constraint",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("CR-024 public messages are English and codes are unchanged", () => {
  const app = () =>
    createApp({ isReady: async () => true }, fakeAuth(), {
      authRateLimiter: createAuthRateLimiter({ maxAttempts: 1 }),
    });

  it.each([
    [
      "ambiguous credentials",
      () =>
        request(app())
          .get("/api/v1/auth/profile")
          .set("Authorization", "Bearer x")
          .set("Cookie", COOKIE),
      400,
      "AMBIGUOUS_AUTH",
      "Send either an Authorization header or a session cookie, not both",
    ],
    [
      "Authorization alone",
      () =>
        request(app())
          .get("/api/v1/auth/profile")
          .set("Authorization", "Bearer x"),
      401,
      "UNAUTHENTICATED",
      "Unauthenticated",
    ],
    [
      "missing session",
      () => request(app()).get("/api/v1/auth/profile"),
      401,
      "UNAUTHENTICATED",
      "Unauthenticated",
    ],
    [
      "foreign origin",
      () =>
        request(app())
          .post("/api/v1/auth/logout")
          .set({ Host: "127.0.0.1", Origin: "http://evil.example" })
          .set("Cookie", COOKIE),
      403,
      "FORBIDDEN_ORIGIN",
      "Origin not allowed",
    ],
    [
      "unknown route",
      () => request(app()).get("/api/v1/nope"),
      404,
      "NOT_FOUND",
      "Route not found",
    ],
    [
      "invalid JSON",
      () =>
        request(app())
          .post("/api/v1/auth/login")
          .set("Content-Type", "application/json")
          .send("{"),
      400,
      "INVALID_JSON",
      "Invalid JSON body",
    ],
    [
      "oversized body",
      () =>
        request(app())
          .post("/api/v1/auth/login")
          .send({ rut: "1", password: "x".repeat(20_000) }),
      413,
      "PAYLOAD_TOO_LARGE",
      "Request body too large",
    ],
    [
      "malformed escape",
      () => request(app()).get("/api/v1/organizations/%E0%A4%A/groups"),
      400,
      "BAD_REQUEST",
      "Bad request",
    ],
    [
      "invalid password change",
      () =>
        request(app())
          .post("/api/v1/auth/change-password")
          .set(SAME_ORIGIN)
          .set("Cookie", COOKIE)
          .send({ currentPassword: "old", newPassword: "short" }),
      400,
      "VALIDATION_ERROR",
      "Invalid password change",
    ],
  ] as const)("%s", async (_label, send, status, code, message) => {
    const response = await send();
    expect(response.status).toBe(status);
    expect(response.body.error).toMatchObject({ code, message });
  });

  it("answers the rate limit and onboarding gate in English", async () => {
    silenceLogs();
    const limited = createApp(
      { isReady: async () => true },
      fakeAuth({
        async login() {
          throw new AuthError(401, "Invalid credentials");
        },
      }),
      { authRateLimiter: createAuthRateLimiter({ maxAttempts: 1 }) },
    );
    await request(limited)
      .post("/api/v1/auth/login")
      .send({ rut: RUT, password: "x" });
    const blocked = await request(limited)
      .post("/api/v1/auth/login")
      .send({ rut: RUT, password: "x" });
    expect(blocked.body.error).toEqual({
      code: "RATE_LIMITED",
      message: "Too many attempts; wait before trying again",
    });

    const pending = createApp(
      { isReady: async () => true },
      fakeAuth({
        async getProfile() {
          return { ...profile, mustChangePassword: true };
        },
      }),
      {
        groups: {
          listGroups: async () => [],
        } as unknown as GroupCatalogService,
      },
    );
    const gated = await request(pending)
      .get("/api/v1/groups")
      .set("Cookie", COOKIE);
    expect(gated.body.error).toEqual({
      code: "ONBOARDING_REQUIRED",
      message: "Password change required",
    });
  });

  it("reports a too-short new password under its field with the rule in English", async () => {
    const response = await request(app())
      .post("/api/v1/auth/change-password")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send({ currentPassword: "old-password-123", newPassword: "short" });

    expect(response.body.error.fields.newPassword).toBe(
      "The new password must have at least 12 characters",
    );
  });

  it("maps PASSWORD_REUSE to its own code with the service message", async () => {
    const reuse = createApp(
      { isReady: async () => true },
      fakeAuth({
        async changePassword() {
          throw new AuthError(
            400,
            "The new password must differ from the current one.",
            "PASSWORD_REUSE",
          );
        },
      }),
    );
    const response = await request(reuse)
      .post("/api/v1/auth/change-password")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send({
        currentPassword: "same-password-12",
        newPassword: "same-password-12",
      });

    expect(response.body.error).toEqual({
      code: "PASSWORD_REUSE",
      message: "The new password must differ from the current one.",
    });
  });
});

describe("CR-007 password bounds are enforced by the schema", () => {
  it.each([
    ["a 256 character new password", "x".repeat(256), 204],
    ["a 257 character new password", "x".repeat(257), 400],
    ["an 11 character new password", "x".repeat(11), 400],
    ["a 12 character new password", "x".repeat(12), 204],
  ])("change-password with %s", async (_label, newPassword, status) => {
    const app = createApp({ isReady: async () => true }, fakeAuth());
    const response = await request(app)
      .post("/api/v1/auth/change-password")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send({ currentPassword: "old-password-123", newPassword });

    expect(response.status).toBe(status);
    if (status === 400) {
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(Object.keys(response.body.error.fields)).toEqual(["newPassword"]);
    }
  });

  it("rejects an oversized current password with a field error", async () => {
    const app = createApp({ isReady: async () => true }, fakeAuth());
    const response = await request(app)
      .post("/api/v1/auth/change-password")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send({ currentPassword: "x".repeat(257), newPassword: "x".repeat(12) });

    expect(response.status).toBe(400);
    expect(Object.keys(response.body.error.fields)).toEqual([
      "currentPassword",
    ]);
  });

  it("treats an oversized login password as a failed login", async () => {
    silenceLogs();
    const login = vi.fn();
    const app = createApp({ isReady: async () => true }, fakeAuth({ login }));
    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ rut: RUT, password: "x".repeat(257) });

    expect(response.status).toBe(401);
    expect(login).not.toHaveBeenCalled();
  });
});
