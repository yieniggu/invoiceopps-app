import request, { type Response } from "../support/request.js";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";
import type { AdminUserService } from "../../src/features/admin-users/services.js";

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ACTOR = "user-1";

const flags = {
  readInvoices: true,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: true,
};

function harness(
  options: { platform?: boolean; mustChangePassword?: boolean } = {},
) {
  const adminUsers = {
    createUser: vi.fn(async () => ({
      user: {
        id: "u2",
        name: "Ada",
        rut: "123456785",
        mustChangePassword: true,
      },
      memberships: [],
      temporaryPassword: "secret-once",
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

const post = (app: ReturnType<typeof harness>["app"], body: unknown) => {
  const call = request(app)
    .post("/api/v1/admin/users")
    .set(SAME_ORIGIN)
    .set("Cookie", COOKIE);
  return body === undefined
    ? call
    : call.set("Content-Type", "application/json").send(JSON.stringify(body));
};

function expectRejected(response: Response) {
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe("VALIDATION_ERROR");
}

const valid = { name: " Ada ", rut: "12.345.678-5", memberships: [] };

describe("POST /api/v1/admin/users over HTTP", () => {
  it("answers 201 with Cache-Control: no-store and passes the parsed input to the service", async () => {
    const { app, adminUsers } = harness();
    const body = {
      ...valid,
      memberships: [
        {
          organizationId: "o1",
          role: "USER",
          permissions: flags,
          groups: [{ groupId: "g1", permissions: flags }, { groupId: "g2" }],
        },
        { organizationId: "o2", role: "ADMIN" },
      ],
    };

    const response = await post(app, body);

    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expect(response.body.temporaryPassword).toBe("secret-once");
    expect(adminUsers.createUser).toHaveBeenCalledWith(ACTOR, {
      name: "Ada",
      rut: "123456785",
      memberships: body.memberships,
    });
  });

  it.each([
    ["8", "x".repeat(8), 201],
    ["256", "x".repeat(256), 201],
    ["7", "x".repeat(7), 400],
    ["257", "x".repeat(257), 400],
  ])(
    "validates a defined temporaryPassword of %s characters",
    async (_label, temporaryPassword, status) => {
      const { app, adminUsers } = harness();
      const response = await post(app, { ...valid, temporaryPassword });
      expect(response.status).toBe(status);
      if (status === 201) {
        expect(adminUsers.createUser).toHaveBeenCalledWith(ACTOR, {
          name: "Ada",
          rut: "123456785",
          memberships: [],
          temporaryPassword,
        });
      } else {
        expect(response.body.error.code).toBe("VALIDATION_ERROR");
        expect(adminUsers.createUser).not.toHaveBeenCalled();
      }
    },
  );

  it("does not echo the defined password in a validation error", async () => {
    const { app } = harness();
    const response = await post(app, {
      ...valid,
      temporaryPassword: "short-7",
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain("short-7");
  });

  it("omits temporaryPassword from the response when the service returns none", async () => {
    const { app, adminUsers } = harness();
    adminUsers.createUser.mockResolvedValueOnce({
      user: {
        id: "u2",
        name: "Ada",
        rut: "123456785",
        mustChangePassword: true,
      },
      memberships: [],
    } as never);
    const response = await post(app, {
      ...valid,
      temporaryPassword: "defined-pass",
    });
    expect(response.status).toBe(201);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    expect(response.body).not.toHaveProperty("temporaryPassword");
  });

  it("accepts zero memberships", async () => {
    const { app, adminUsers } = harness();
    const response = await post(app, valid);
    expect(response.status).toBe(201);
    expect(adminUsers.createUser).toHaveBeenCalledWith(ACTOR, {
      name: "Ada",
      rut: "123456785",
      memberships: [],
    });
  });

  it("answers 401 without a session", async () => {
    const { app } = harness();
    const response = await request(app)
      .post("/api/v1/admin/users")
      .set(SAME_ORIGIN)
      .send(valid);
    expect(response.status).toBe(401);
  });

  it("rejects Bearer credentials like every other operation", async () => {
    const { app, adminUsers } = harness();
    const response = await request(app)
      .post("/api/v1/admin/users")
      .set(SAME_ORIGIN)
      .set("Authorization", "Bearer token")
      .send(valid);
    expect(response.status).toBe(401);
    expect(adminUsers.createUser).not.toHaveBeenCalled();
  });

  it("answers 400 AMBIGUOUS_AUTH when Bearer and the cookie are both sent", async () => {
    const { app, adminUsers } = harness();
    const response = await post(app, valid).set(
      "Authorization",
      "Bearer token",
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("AMBIGUOUS_AUTH");
    expect(adminUsers.createUser).not.toHaveBeenCalled();
  });

  it("keeps the Origin check on the cookie write", async () => {
    const { app, adminUsers } = harness();
    const response = await request(app)
      .post("/api/v1/admin/users")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://evil.example")
      .set("Cookie", COOKIE)
      .send(valid);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN_ORIGIN");
    expect(adminUsers.createUser).not.toHaveBeenCalled();
  });

  it("answers 403 FORBIDDEN to anyone but the platform administrator", async () => {
    const { app, adminUsers } = harness({ platform: false });
    const response = await post(app, valid);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(adminUsers.createUser).not.toHaveBeenCalled();
  });

  // Same order as every other write (body first, then authority): an invalid
  // body is a 400 even for a non-administrator; nothing is created either way.
  it("validates the body before the authority, like every other write", async () => {
    const { app, adminUsers } = harness({ platform: false });
    for (const body of [{}, undefined]) {
      const response = await post(app, body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(adminUsers.createUser).not.toHaveBeenCalled();
  });

  it("answers 403 ONBOARDING_REQUIRED while a temporary password is pending", async () => {
    const { app, adminUsers } = harness({ mustChangePassword: true });
    const response = await post(app, valid);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("ONBOARDING_REQUIRED");
    expect(adminUsers.createUser).not.toHaveBeenCalled();
  });

  const group = (id: string) => ({ groupId: id });
  const membership = (id: string, extra: object = {}) => ({
    organizationId: id,
    role: "USER",
    ...extra,
  });
  const cases: Array<[string, unknown]> = [
    ["no body", undefined],
    ["array body", []],
    ["missing memberships", { name: "Ada", rut: "12.345.678-5" }],
    ["memberships not an array", { ...valid, memberships: "o1" }],
    ["missing name", { rut: "12.345.678-5", memberships: [] }],
    ["blank name", { ...valid, name: " " }],
    ["name of 121", { ...valid, name: "x".repeat(121) }],
    ["invalid RUT", { ...valid, rut: "11.111.111-2" }],
    ["numeric RUT", { ...valid, rut: 123456785 }],
    ["extra top-level key", { ...valid, role: "USER" }],
    [
      "duplicate organizationId",
      { ...valid, memberships: [membership("o1"), membership("o1")] },
    ],
    [
      "51 organizations",
      {
        ...valid,
        memberships: Array.from({ length: 51 }, (_unused, index) =>
          membership(`o${index}`),
        ),
      },
    ],
    [
      "unknown role",
      { ...valid, memberships: [membership("o1", { role: "OWNER" })] },
    ],
    ["missing role", { ...valid, memberships: [{ organizationId: "o1" }] }],
    ["missing organizationId", { ...valid, memberships: [{ role: "USER" }] }],
    ["blank organizationId", { ...valid, memberships: [membership(" ")] }],
    [
      "partial membership permissions",
      {
        ...valid,
        memberships: [
          membership("o1", { permissions: { readInvoices: true } }),
        ],
      },
    ],
    [
      "extra membership key",
      { ...valid, memberships: [membership("o1", { x: 1 })] },
    ],
    [
      "duplicate groupId in an organization",
      {
        ...valid,
        memberships: [membership("o1", { groups: [group("g1"), group("g1")] })],
      },
    ],
    [
      "201 groups in an organization",
      {
        ...valid,
        memberships: [
          membership("o1", {
            groups: Array.from({ length: 201 }, (_unused, index) =>
              group(`g${index}`),
            ),
          }),
        ],
      },
    ],
    [
      "group without id",
      {
        ...valid,
        memberships: [membership("o1", { groups: [{ permissions: flags }] })],
      },
    ],
    [
      "group with partial permissions",
      {
        ...valid,
        memberships: [
          membership("o1", {
            groups: [{ groupId: "g1", permissions: { readInvoices: true } }],
          }),
        ],
      },
    ],
    [
      "group with extra key",
      {
        ...valid,
        memberships: [membership("o1", { groups: [{ groupId: "g1", x: 1 }] })],
      },
    ],
  ];

  it.each(cases)(
    "rejects %s with 400 and calls no service",
    async (_label, body) => {
      const { app, adminUsers } = harness();
      expectRejected(await post(app, body));
      expect(adminUsers.createUser).not.toHaveBeenCalled();
    },
  );

  it("allows the same groupId under two different organizations", async () => {
    const { app, adminUsers } = harness();
    const response = await post(app, {
      ...valid,
      memberships: [
        membership("o1", { groups: [group("g1")] }),
        membership("o2", { groups: [group("g1")] }),
      ],
    });
    expect(response.status).toBe(201);
    expect(adminUsers.createUser).toHaveBeenCalledTimes(1);
  });
});
