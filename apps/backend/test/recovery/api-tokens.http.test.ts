import { describe, expect, it, vi } from "vitest";

import { createAuthRateLimiter } from "../../src/auth-rate-limit.js";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";
import type { ApiTokenService } from "../../src/features/api-tokens/services.js";

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ORG = "11111111-1111-4111-8111-111111111111";
const TOKEN_ID = "44444444-4444-4444-8444-444444444444";
const DAY_MS = 24 * 60 * 60 * 1000;

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

function fakeAuth(mustChangePassword = false, id = "user-1"): AuthService {
  return {
    async login() {
      return {
        sessionToken: "opaque-session-token",
        user: { id: "user-1", name: "Ada", rut: "123456785" },
      };
    },
    async logout() {},
    async getProfile() {
      return { ...profile, id, mustChangePassword };
    },
    async updateProfile() {
      return profile;
    },
    async changePassword() {
      return { sessionToken: "rotated-session-token" };
    },
  };
}

const app = () => createApp({ isReady: async () => true }, fakeAuth());

const valid = () => ({
  name: "ci pipeline",
  organizationId: ORG,
  scopes: ["invoices:read"],
  expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString(),
});

const post = (body?: unknown) => {
  const test = request(app())
    .post("/api/v1/api-tokens")
    .set(SAME_ORIGIN)
    .set("Cookie", COOKIE);
  return body === undefined ? test : test.send(body as object);
};

describe("POST /api/v1/api-tokens validation (AC-06)", () => {
  it.each([
    ["missing expiresAt", (b: Record<string, unknown>) => delete b.expiresAt],
    [
      "expiresAt in the past",
      (b: Record<string, unknown>) => {
        b.expiresAt = new Date(Date.now() - DAY_MS).toISOString();
      },
    ],
    [
      "expiresAt more than 30 days ahead",
      (b: Record<string, unknown>) => {
        b.expiresAt = new Date(Date.now() + 31 * DAY_MS).toISOString();
      },
    ],
    [
      "expiresAt that is not a date",
      (b: Record<string, unknown>) => {
        b.expiresAt = "tomorrow";
      },
    ],
    [
      "an unknown scope",
      (b: Record<string, unknown>) => {
        b.scopes = ["invoices:everything"];
      },
    ],
    ["missing scopes", (b: Record<string, unknown>) => delete b.scopes],
    [
      "a blank name",
      (b: Record<string, unknown>) => {
        b.name = "  ";
      },
    ],
    [
      "a malformed organizationId",
      (b: Record<string, unknown>) => {
        b.organizationId = "nope";
      },
    ],
    [
      "an unknown field",
      (b: Record<string, unknown>) => {
        b.tokenHash = "x";
      },
    ],
  ])("answers 400 VALIDATION_ERROR for %s", async (_label, mutate) => {
    const body = valid() as Record<string, unknown>;
    mutate(body);

    const response = await post(body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("keeps the Origin check on the cookie write", async () => {
    const response = await request(app())
      .post("/api/v1/api-tokens")
      .set({ Host: "127.0.0.1", Origin: "http://evil.example" })
      .set("Cookie", COOKIE)
      .send(valid());

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("answers 401 UNAUTHENTICATED without a session", async () => {
    const response = await request(app())
      .post("/api/v1/api-tokens")
      .set(SAME_ORIGIN)
      .send(valid());

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("token management is session-only (AC-07)", () => {
  const SECRET = "iop_not-a-real-secret";

  it.each([
    ["post", "/api/v1/api-tokens"],
    ["get", `/api/v1/api-tokens?organizationId=${ORG}`],
    ["delete", `/api/v1/api-tokens/${TOKEN_ID}`],
  ] as const)("answers 401 to Bearer on %s %s", async (method, path) => {
    const agent = request(app());
    const test = agent[method](path).set("Authorization", `Bearer ${SECRET}`);
    const response = await (method === "post" ? test.send(valid()) : test);

    expect(response.status).toBe(401);
  });

  it("answers 400 AMBIGUOUS_AUTH when Bearer and the cookie are both sent", async () => {
    const response = await post(valid()).set(
      "Authorization",
      `Bearer ${SECRET}`,
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("AMBIGUOUS_AUTH");
  });
});

describe("GET/DELETE /api/v1/api-tokens routes exist behind the session (AC-11)", () => {
  it("answers 401 UNAUTHENTICATED (not 404) to an anonymous list", async () => {
    const response = await request(app()).get(
      `/api/v1/api-tokens?organizationId=${ORG}`,
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("answers 401 UNAUTHENTICATED (not 404) to an anonymous revoke", async () => {
    const response = await request(app())
      .delete(`/api/v1/api-tokens/${TOKEN_ID}`)
      .set(SAME_ORIGIN);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("blocks token management while a temporary password is pending", async () => {
    const response = await request(
      createApp({ isReady: async () => true }, fakeAuth(true)),
    )
      .get(`/api/v1/api-tokens?organizationId=${ORG}`)
      .set("Cookie", COOKIE);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ONBOARDING_REQUIRED");
  });
});

describe("POST /api/v1/api-tokens issuance rate limit (CR-332)", () => {
  function limitedApp(userId: string, service: ApiTokenService) {
    return createApp({ isReady: async () => true }, fakeAuth(false, userId), {
      apiTokens: service,
    });
  }

  function fakeService() {
    const createToken = vi.fn<ApiTokenService["createToken"]>(async () => ({
      token: {
        id: TOKEN_ID,
        name: "ci pipeline",
        organizationId: ORG,
        groupId: null,
        scopes: ["invoices:read"],
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + DAY_MS).toISOString(),
        revokedAt: null,
      },
      secret: "iop_fake",
    }));
    const service = { createToken } as unknown as ApiTokenService;
    return { createToken, service };
  }

  const issue = (instance: ReturnType<typeof limitedApp>) =>
    request(instance)
      .post("/api/v1/api-tokens")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send(valid());

  it("answers 429 RATE_LIMITED after 20 attempts of one user, per user", async () => {
    const { createToken, service } = fakeService();
    const first = limitedApp("user-a", service);

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      expect((await issue(first)).status).toBe(201);
    }
    const blocked = await issue(first);

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(createToken).toHaveBeenCalledTimes(20);
  });

  it("counts invalid attempts and keeps other users unaffected", async () => {
    const { createToken, service } = fakeService();
    const limiter = createAuthRateLimiter({ maxAttempts: 2 });
    const build = (userId: string) =>
      createApp({ isReady: async () => true }, fakeAuth(false, userId), {
        apiTokens: service,
        apiTokenIssuanceLimiter: limiter,
      });
    const invalid = (instance: ReturnType<typeof build>) =>
      request(instance)
        .post("/api/v1/api-tokens")
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE)
        .send({});

    expect((await invalid(build("user-a"))).status).toBe(400);
    expect((await invalid(build("user-a"))).status).toBe(400);
    expect((await invalid(build("user-a"))).status).toBe(429);
    expect((await issue(build("user-b"))).status).toBe(201);
    expect(createToken).toHaveBeenCalledTimes(1);
  });

  it("limits nothing for an anonymous caller (401 first)", async () => {
    const { service } = fakeService();
    const response = await request(limitedApp("user-a", service))
      .post("/api/v1/api-tokens")
      .set(SAME_ORIGIN)
      .send(valid());

    expect(response.status).toBe(401);
  });
});
