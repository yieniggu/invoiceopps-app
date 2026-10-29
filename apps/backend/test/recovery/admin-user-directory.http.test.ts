import request from "../support/request.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";
import type { AdminUserService } from "../../src/features/admin-users/services.js";

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ACTOR = "user-1";
const TARGET = "user-2";

const detailUser = {
  id: TARGET,
  name: "Grace",
  rut: "12.345.678-5",
  email: null,
  disabledAt: null,
  mustChangePassword: false,
  recentlyActive: false,
  isPlatformAdministrator: false,
};

function harness(
  options: { platform?: boolean; mustChangePassword?: boolean } = {},
) {
  const adminUsers = {
    listUsers: vi.fn(async () => ({
      users: [],
      page: 1,
      pageSize: 20,
      total: 0,
    })),
    getUser: vi.fn(async () => ({ user: detailUser, memberships: [] })),
    updateUser: vi.fn(async () => ({
      result: { user: detailUser },
      changed: true,
    })),
    resetPassword: vi.fn(async () => ({
      temporaryPassword: "generated-once",
      expiresAt: "2026-10-29T00:00:00.000Z",
    })),
  };
  const profile = {
    id: ACTOR,
    name: "Ada",
    rut: "123456785",
    email: null,
    username: null,
    mustChangePassword: options.mustChangePassword ?? false,
    isPlatformAdministrator: options.platform ?? true,
    memberships: [],
  };
  const auth = {
    login: vi.fn(),
    logout: vi.fn(),
    getProfile: vi.fn(async () => profile),
    updateProfile: vi.fn(async () => profile),
  } as unknown as AuthService;
  const app = createApp({ isReady: async () => true }, auth, {
    adminUsers: adminUsers as unknown as AdminUserService,
  });
  return { app, adminUsers };
}

type Harness = ReturnType<typeof harness>;

const list = (h: Harness, query = "") =>
  request(h.app).get(`/api/v1/admin/users${query}`).set("Cookie", COOKIE);
const detail = (h: Harness) =>
  request(h.app).get(`/api/v1/admin/users/${TARGET}`).set("Cookie", COOKIE);
const patch = (h: Harness, body: unknown) =>
  request(h.app)
    .patch(`/api/v1/admin/users/${TARGET}`)
    .set(SAME_ORIGIN)
    .set("Cookie", COOKIE)
    .send(body as object);
const reset = (h: Harness, body: unknown) =>
  request(h.app)
    .post(`/api/v1/admin/users/${TARGET}/password-reset`)
    .set(SAME_ORIGIN)
    .set("Cookie", COOKIE)
    .send(body as object);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/v1/admin/users over HTTP", () => {
  it("applies the defaults and passes the parsed query to the service", async () => {
    const h = harness();
    const response = await list(h);
    expect(response.status).toBe(200);
    expect(h.adminUsers.listUsers).toHaveBeenCalledWith(ACTOR, {
      status: "all",
      page: 1,
      pageSize: 20,
    });
  });

  it("trims the search and coerces numeric parameters", async () => {
    const h = harness();
    const response = await list(
      h,
      "?search=%20ada%20&status=disabled&page=3&pageSize=100",
    );
    expect(response.status).toBe(200);
    expect(h.adminUsers.listUsers).toHaveBeenCalledWith(ACTOR, {
      search: "ada",
      status: "disabled",
      page: 3,
      pageSize: 100,
    });
  });

  it.each([
    ["unknown parameter", "?foo=1"],
    ["empty search", "?search="],
    ["blank search", "?search=%20%20"],
    ["search of 121", `?search=${"x".repeat(121)}`],
    ["repeated search", "?search=a&search=b"],
    ["search that is a NUL character", "?search=%00"],
    ["search with a NUL character inside", "?search=ada%00lovelace"],
    ["unknown status", "?status=bogus"],
    ["page 0", "?page=0"],
    ["fractional page", "?page=1.5"],
    ["page above the maximum", "?page=10001"],
    ["pageSize 0", "?pageSize=0"],
    ["pageSize 101", "?pageSize=101"],
    ["non numeric pageSize", "?pageSize=abc"],
  ])("rejects %s with 400 and calls no service", async (_label, query) => {
    const h = harness();
    const response = await list(h, query);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(h.adminUsers.listUsers).not.toHaveBeenCalled();
  });

  it("accepts the boundary values", async () => {
    const h = harness();
    expect((await list(h, "?page=10000")).status).toBe(200);
    expect(
      (await list(h, `?search=${"x".repeat(120)}&pageSize=1`)).status,
    ).toBe(200);
  });

  it("answers 401 without a session and 403 to anyone but the platform administrator", async () => {
    const h = harness({ platform: false });
    const anonymous = await request(h.app).get("/api/v1/admin/users");
    const forbidden = await list(h);
    expect(anonymous.status).toBe(401);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
    expect(h.adminUsers.listUsers).not.toHaveBeenCalled();
  });

  it("validates the query before the authority", async () => {
    const h = harness({ platform: false });
    const response = await list(h, "?foo=1");
    expect(response.status).toBe(400);
  });

  it("answers 403 ONBOARDING_REQUIRED while a temporary password is pending", async () => {
    const h = harness({ mustChangePassword: true });
    const response = await list(h);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ONBOARDING_REQUIRED");
    // Control: the route exists and answers 200 once onboarding is complete.
    expect((await list(harness())).status).toBe(200);
  });
});

describe("GET /api/v1/admin/users/{userId} over HTTP", () => {
  it("returns the service result", async () => {
    const h = harness();
    const response = await detail(h);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ user: detailUser, memberships: [] });
    expect(h.adminUsers.getUser).toHaveBeenCalledWith(ACTOR, TARGET);
  });

  it("answers 403 to a non administrator without calling the service", async () => {
    const h = harness({ platform: false });
    const response = await detail(h);
    expect(response.status).toBe(403);
    expect(h.adminUsers.getUser).not.toHaveBeenCalled();
  });

  it("maps a service NOT_FOUND to 404", async () => {
    const h = harness();
    // Control: the route exists, so the 404 below comes from the service.
    expect((await detail(h)).status).toBe(200);
    const { ApiError } = await import("../../src/http/errors.js");
    h.adminUsers.getUser.mockRejectedValueOnce(
      new ApiError(404, "NOT_FOUND", "Not found"),
    );
    const response = await detail(h);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

describe("PATCH /api/v1/admin/users/{userId} over HTTP", () => {
  it("passes the canonical RUT and the trimmed name to the service", async () => {
    const h = harness();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await patch(h, { name: " Grace ", rut: "12.345.678-5" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ user: detailUser });
    expect(h.adminUsers.updateUser).toHaveBeenCalledWith(ACTOR, TARGET, {
      name: "Grace",
      rut: "123456785",
    });
    const logged = info.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged).toContainEqual(
      expect.objectContaining({
        event: "audit.user_updated",
        actorUserId: ACTOR,
        targetUserId: TARGET,
      }),
    );
    expect(JSON.stringify(logged)).not.toContain("123456785");
    expect(JSON.stringify(logged)).not.toContain("Grace");
  });

  it("logs nothing when the update changed nothing", async () => {
    const h = harness();
    h.adminUsers.updateUser.mockResolvedValueOnce({
      result: { user: detailUser },
      changed: false,
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await patch(h, { name: "Grace" });
    expect(response.status).toBe(200);
    expect(
      info.mock.calls.filter(([line]) => String(line).includes("user_updated")),
    ).toEqual([]);
  });

  it.each([
    ["empty object", {}],
    ["unknown field", { name: "Grace", role: "ADMIN" }],
    ["only an unknown field", { email: "a@b.c" }],
    ["blank name", { name: "  " }],
    ["name of 121", { name: "x".repeat(121) }],
    ["invalid RUT", { rut: "11.111.111-2" }],
    ["numeric RUT", { rut: 123456785 }],
    ["array body", []],
  ])("rejects %s with 400 and calls no service", async (_label, body) => {
    const h = harness();
    const response = await patch(h, body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(h.adminUsers.updateUser).not.toHaveBeenCalled();
  });

  it("validates the body before the authority and answers 403 for a valid body", async () => {
    const h = harness({ platform: false });
    expect((await patch(h, {})).status).toBe(400);
    const forbidden = await patch(h, { name: "Grace" });
    expect(forbidden.status).toBe(403);
    expect(h.adminUsers.updateUser).not.toHaveBeenCalled();
  });

  it("keeps the Origin check", async () => {
    const h = harness();
    const response = await request(h.app)
      .patch(`/api/v1/admin/users/${TARGET}`)
      .set({ Host: "127.0.0.1", Origin: "http://evil.example" })
      .set("Cookie", COOKIE)
      .send({ name: "Grace" });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN_ORIGIN");
    expect(h.adminUsers.updateUser).not.toHaveBeenCalled();
    // Control: the same write from the same origin goes through.
    expect((await patch(h, { name: "Grace" })).status).toBe(200);
  });
});

describe("POST /api/v1/admin/users/{userId}/password-reset over HTTP", () => {
  it("answers 200 with Cache-Control: no-store and the generated password", async () => {
    const h = harness();
    const response = await reset(h, {});
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expect(response.body).toEqual({
      temporaryPassword: "generated-once",
      expiresAt: "2026-10-29T00:00:00.000Z",
    });
    expect(h.adminUsers.resetPassword).toHaveBeenCalledWith(ACTOR, TARGET, {});
  });

  it("passes an admin-defined password and omits it from the response", async () => {
    const h = harness();
    h.adminUsers.resetPassword.mockResolvedValueOnce({
      expiresAt: "2026-10-29T00:00:00.000Z",
    } as never);
    const response = await reset(h, { temporaryPassword: "defined-pass-1" });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expect(response.body).not.toHaveProperty("temporaryPassword");
    expect(h.adminUsers.resetPassword).toHaveBeenCalledWith(ACTOR, TARGET, {
      temporaryPassword: "defined-pass-1",
    });
  });

  it.each([
    ["8", "x".repeat(8), 200],
    ["256", "x".repeat(256), 200],
    ["7", "x".repeat(7), 400],
    ["257", "x".repeat(257), 400],
  ])(
    "validates a temporaryPassword of %s characters",
    async (_label, temporaryPassword, status) => {
      const h = harness();
      const response = await reset(h, { temporaryPassword });
      expect(response.status).toBe(status);
      if (status === 400) {
        expect(response.body.error.code).toBe("VALIDATION_ERROR");
        expect(JSON.stringify(response.body)).not.toContain(temporaryPassword);
        expect(h.adminUsers.resetPassword).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["unknown field", { temporaryPassword: "defined-pass-1", extra: 1 }],
    ["numeric password", { temporaryPassword: 12345678 }],
    ["array body", []],
    ["no body", undefined],
  ])("rejects %s with 400 and calls no service", async (_label, body) => {
    const h = harness();
    const call = request(h.app)
      .post(`/api/v1/admin/users/${TARGET}/password-reset`)
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE);
    const response =
      body === undefined ? await call : await call.send(body as object);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(h.adminUsers.resetPassword).not.toHaveBeenCalled();
  });

  it("validates the body before the authority, then answers 403", async () => {
    const h = harness({ platform: false });
    expect((await reset(h, { extra: 1 })).status).toBe(400);
    expect((await reset(h, {})).status).toBe(403);
    expect(h.adminUsers.resetPassword).not.toHaveBeenCalled();
  });

  it("never logs the password", async () => {
    const h = harness();
    const writers = (["info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const response = await reset(h, { temporaryPassword: "never-in-logs-1" });
    expect(response.status).toBe(200);
    const logged = writers
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .join("\n");
    expect(logged).not.toContain("never-in-logs-1");
    expect(logged).not.toContain("generated-once");
  });

  it("keeps the Origin check", async () => {
    const h = harness();
    const response = await request(h.app)
      .post(`/api/v1/admin/users/${TARGET}/password-reset`)
      .set({ Host: "127.0.0.1", Origin: "http://evil.example" })
      .set("Cookie", COOKIE)
      .send({});
    expect(response.status).toBe(403);
    expect(h.adminUsers.resetPassword).not.toHaveBeenCalled();
    // Control: the same write from the same origin goes through.
    expect((await reset(h, {})).status).toBe(200);
  });
});
