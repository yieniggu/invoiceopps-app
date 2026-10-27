import request, { type Response, type Test } from "../support/request.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { AuthError, type AuthService } from "../../src/auth.js";
import type { GroupCatalogService } from "../../src/features/groups/services.js";

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
    async changePassword() {},
    ...overrides,
  };
}

function buildApp(auth: AuthService = fakeAuth()) {
  return createApp({ isReady: async () => true }, auth, {
    groups: { listGroups: async () => [] } as unknown as GroupCatalogService,
  });
}

function expectEnvelope(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.body).toMatchObject({
    error: { code, message: expect.any(String) },
  });
  expect(response.body).not.toHaveProperty("status");
  expect(Object.keys(response.body)).toEqual(["error"]);
  expect(JSON.stringify(response.body)).not.toMatch(/\bat .+\(.+:\d+:\d+\)/);
  expect(JSON.stringify(response.body)).not.toContain("stack");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RP0 /api/v1 route prefix", () => {
  it("serves the auth routes under /api/v1 with the same subpaths", async () => {
    const app = buildApp();

    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ rut: "12.345.678-5", password: "correct-horse-battery-staple" });
    const getProfile = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", COOKIE);
    const patchProfile = await request(app)
      .patch("/api/v1/profile")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send({ username: "ada-l" });
    const changePassword = await request(app)
      .post("/api/v1/auth/change-password")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send({
        currentPassword: "temporary-password",
        newPassword: "changed-password-123",
      });
    const logout = await request(app)
      .post("/api/v1/auth/logout")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);

    expect(login.status).toBe(200);
    expect(String(login.headers["set-cookie"])).toMatch(/HttpOnly/i);
    expect(getProfile.status).toBe(200);
    expect(patchProfile.status).toBe(200);
    expect(changePassword.status).toBe(204);
    expect(logout.status).toBe(204);
  });

  it("serves the other functional routes under /api/v1", async () => {
    const app = buildApp();

    const groups = await request(app)
      .get("/api/v1/groups")
      .set("Cookie", COOKIE);
    const invoices = await request(app)
      .get("/api/v1/invoices")
      .set("Cookie", COOKIE);
    const policies = await request(app)
      .get("/api/v1/business-policies")
      .set("Cookie", COOKIE);
    const organizations = await request(app)
      .get("/api/v1/organizations")
      .set("Cookie", COOKIE);
    const orgGroups = await request(app)
      .get("/api/v1/organizations/11111111-1111-4111-8111-111111111111/groups")
      .set("Cookie", COOKIE);

    // These may be 403/503 without full fakes, but the route must exist, so
    // never the generic unknown-route 404.
    for (const response of [
      groups,
      invoices,
      policies,
      organizations,
      orgGroups,
    ]) {
      expect(response.body?.error?.code).not.toBe("NOT_FOUND");
      expect(response.status).not.toBe(404);
    }
    expect(groups.status).toBe(200);
  });

  it("no longer serves the old root functional paths", async () => {
    const app = buildApp();
    const oldRoutes: Array<[string, string]> = [
      ["post", "/auth/login"],
      ["get", "/profile"],
      ["patch", "/profile"],
      ["post", "/auth/logout"],
      ["post", "/auth/change-password"],
      ["get", "/groups"],
      ["get", "/invoices"],
      ["get", "/business-policies"],
      ["get", "/organizations"],
      ["get", "/organizations/11111111-1111-4111-8111-111111111111/groups"],
    ];

    for (const [method, path] of oldRoutes) {
      const response = await (
        request(app) as unknown as Record<string, (path: string) => Test>
      )[method](path);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it("keeps health probes at the root and not under /api/v1", async () => {
    const app = buildApp();

    expect((await request(app).get("/health/live")).status).toBe(200);
    expect((await request(app).get("/health/ready")).status).toBe(200);
    expect((await request(app).get("/api/v1/health/live")).status).toBe(404);
  });
});

describe("RP0 uniform error envelope", () => {
  it("returns 404 NOT_FOUND for unknown routes under /api/v1", async () => {
    const response = await request(buildApp()).get("/api/v1/does-not-exist");

    expectEnvelope(response, 404, "NOT_FOUND");
  });

  it("returns 400 INVALID_JSON for malformed JSON", async () => {
    const response = await request(buildApp())
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send('{"rut": ');

    expectEnvelope(response, 400, "INVALID_JSON");
  });

  it("returns 413 PAYLOAD_TOO_LARGE for oversized bodies", async () => {
    const response = await request(buildApp())
      .post("/api/v1/auth/login")
      .send({ rut: "1", password: "x".repeat(20_000) });

    expectEnvelope(response, 413, "PAYLOAD_TOO_LARGE");
  });

  it("returns 401 UNAUTHENTICATED when the session is missing", async () => {
    const response = await request(buildApp()).get("/api/v1/auth/profile");

    expectEnvelope(response, 401, "UNAUTHENTICATED");
  });

  it("returns 403 ONBOARDING_REQUIRED while onboarding is pending", async () => {
    const app = buildApp(
      fakeAuth({
        async getProfile() {
          return { ...profile, mustChangePassword: true };
        },
      }),
    );

    const response = await request(app)
      .get("/api/v1/groups")
      .set("Cookie", COOKIE);

    expectEnvelope(response, 403, "ONBOARDING_REQUIRED");
  });

  it("returns 403 FORBIDDEN_ORIGIN for cross-origin cookie writes", async () => {
    const response = await request(buildApp())
      .post("/api/v1/auth/logout")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://evil.example")
      .set("Cookie", COOKIE);

    expectEnvelope(response, 403, "FORBIDDEN_ORIGIN");
  });

  it("returns 400 VALIDATION_ERROR with fields for an unknown profile key", async () => {
    const response = await request(buildApp())
      .patch("/api/v1/profile")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send({ name: "Ada", isPlatformAdministrator: true });

    expectEnvelope(response, 400, "VALIDATION_ERROR");
    expect(response.body.error.fields).toEqual(expect.any(Object));
    expect(Object.keys(response.body.error.fields).length).toBeGreaterThan(0);
    for (const message of Object.values(response.body.error.fields)) {
      expect(message).toEqual(expect.any(String));
    }
  });

  it("returns 500 INTERNAL_ERROR without leaking the cause or stack", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = buildApp(
      fakeAuth({
        async getProfile() {
          throw new Error("secret database failure details");
        },
      }),
    );

    const response = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", COOKIE);

    expectEnvelope(response, 500, "INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("keeps AuthError-driven client errors in the envelope", async () => {
    const app = buildApp(
      fakeAuth({
        async login() {
          throw new AuthError(401, "Invalid credentials");
        },
      }),
    );

    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ rut: "12.345.678-5", password: "wrong" });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      error: { code: expect.any(String), message: expect.any(String) },
    });
    expect(response.body).not.toHaveProperty("status");
  });
});
