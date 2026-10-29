import request from "./support/request.js";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { createAuthRateLimiter } from "../src/auth-rate-limit.js";
import { AuthError, createAuthService, type AuthService } from "../src/auth.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import type {
  GroupCatalogService,
  GroupService,
} from "../src/features/groups/services.js";
import type { OrganizationService } from "../src/features/orgs/services.js";

function createAuthServiceForHttpTest(): AuthService {
  const users = new Map<
    string,
    { id: string; name: string; password: string; rut: string }
  >();
  users.set("123456785", {
    id: "user-1",
    name: "Ada Lovelace",
    rut: "123456785",
    password: "correct-horse-battery-staple",
  });

  return {
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
    async logout() {
      throw new Error("logout must be configured by the test");
    },
    async getProfile() {
      throw new Error("getProfile must be configured by the test");
    },
    async updateProfile() {
      throw new Error("updateProfile must be configured by the test");
    },
  };
}

describe("APP-02 auth HTTP contract", () => {
  it("fails closed on sensitive routes while allowing the constrained temporary-password session endpoints", async () => {
    const profile = {
      id: "user-1",
      name: "Ada",
      rut: "123456785",
      email: null,
      username: null,
      mustChangePassword: true,
      isPlatformAdministrator: false,
      memberships: [],
    };
    const auth: AuthService = {
      async login() {
        throw new Error("not used");
      },
      async logout() {},
      async getProfile() {
        return profile;
      },
      async updateProfile() {
        return profile;
      },
      async changePassword() {},
    };
    const app = createApp({ isReady: async () => true }, auth, {
      groups: { listGroups: async () => [] } as unknown as GroupCatalogService,
    });
    const cookie = "invoiceops_session=temporary-session";
    expect(
      (await request(app).get("/api/v1/groups").set("Cookie", cookie)).status,
    ).toBe(403);
    expect(
      (await request(app).get("/api/v1/auth/profile").set("Cookie", cookie))
        .status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .post("/api/v1/auth/change-password")
          .set("Host", "127.0.0.1")
          .set("Origin", "http://127.0.0.1")
          .set("Cookie", cookie)
          .send({
            currentPassword: "temporary-password",
            newPassword: "changed-password-123",
          })
      ).status,
    ).toBe(204);
  });

  it("rejects public signup and logs in with an httpOnly cookie session without a JSON token", async () => {
    const auth = createAuthServiceForHttpTest();
    const app = createApp({ isReady: async () => true }, auth);
    const credentials = {
      name: "Ada Lovelace",
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    };

    const signupResponse = await request(app)
      .post("/api/v1/auth/signup")
      .send(credentials);
    const loginResponse = await request(app)
      .post("/api/v1/auth/login")
      .send({ rut: credentials.rut, password: credentials.password });

    expect.soft(signupResponse.status).toBe(404);
    expect.soft(loginResponse.status).toBe(200);
    const sessionCookie = String(loginResponse.headers["set-cookie"] ?? "");

    expect.soft(sessionCookie).toMatch(/;\s*HttpOnly(?:;|$)/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
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

    const unknownUser = await request(app).post("/api/v1/auth/login").send({
      rut: "11.111.111-1",
      password: "correct-horse-battery-staple",
    });
    const invalidPassword = await request(app).post("/api/v1/auth/login").send({
      rut: "12.345.678-5",
      password: "not-the-correct-password",
    });

    expect(unknownUser.status).toBe(401);
    expect(invalidPassword.status).toBe(401);
    expect(unknownUser.body).toEqual(invalidPassword.body);
  });

  it("answers a missing or non-object login body with the generic 401", async () => {
    const app = createApp(
      { isReady: async () => true },
      createAuthServiceForHttpTest(),
    );

    const missing = await request(app).post("/api/v1/auth/login");
    const array = await request(app).post("/api/v1/auth/login").send([]);
    const wrongTypes = await request(app)
      .post("/api/v1/auth/login")
      .send({ rut: 1, password: null });

    for (const response of [missing, array, wrongTypes]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: { code: "UNAUTHENTICATED", message: "Invalid credentials" },
      });
    }
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
      request(app).post("/api/v1/auth/login").send({
        rut: "12.345.678-5",
        password: "not-the-correct-password",
      });

    expect((await failedLogin()).status).toBe(401);
    expect((await failedLogin()).status).toBe(401);
    const limitedResponse = await request(app).post("/api/v1/auth/login").send({
      rut: "12.345.678-5",
      password: "correct-horse-battery-staple",
    });

    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.body).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many attempts; wait before trying again",
      },
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

  it("revokes only the current session and clears its compatible cookie", async () => {
    const activeSessions = new Set(["current-session", "other-session"]);
    const app = createApp(
      { isReady: async () => true },
      {
        ...createAuthServiceForHttpTest(),
        async logout(sessionToken: string) {
          if (!activeSessions.delete(sessionToken)) {
            throw new AuthError(401, "Unauthenticated");
          }
        },
        async getProfile(sessionToken: string) {
          if (!activeSessions.has(sessionToken)) {
            throw new AuthError(401, "Unauthenticated");
          }

          return {
            id: "user-1",
            name: "Ada Lovelace",
            rut: "123456785",
            email: null,
            username: null,
            isPlatformAdministrator: false,
            memberships: [],
          };
        },
        async updateProfile() {
          throw new Error("not used");
        },
      },
    );

    const logout = await request(app)
      .post("/api/v1/auth/logout")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=current-session");
    const revokedProfile = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", "invoiceops_session=current-session");
    const otherProfile = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", "invoiceops_session=other-session");

    expect(logout.status).toBe(204);
    expect(String(logout.headers["set-cookie"] ?? "")).toMatch(
      /invoiceops_session=;.*Path=\/;.*HttpOnly.*SameSite=Lax/i,
    );
    expect(revokedProfile.status).toBe(401);
    expect(otherProfile.status).toBe(200);
  });

  it("returns the existing safe 401 for absent, invalid, and expired logout sessions", async () => {
    const app = createApp(
      { isReady: async () => true },
      {
        ...createAuthServiceForHttpTest(),
        async logout() {
          throw new AuthError(401, "Unauthenticated");
        },
      },
    );

    const absent = await request(app).post("/api/v1/auth/logout");
    const invalid = await request(app)
      .post("/api/v1/auth/logout")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=invalid-session");
    const expired = await request(app)
      .post("/api/v1/auth/logout")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=expired-session");

    expect(absent.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(expired.status).toBe(401);
    expect(absent.body).toEqual(invalid.body);
    expect(invalid.body).toEqual(expired.body);
  });
});

const NO_FLAGS = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};

describe("APP-03 profile HTTP contract", () => {
  it("returns the authenticated profile and deterministically ordered memberships", async () => {
    const app = createApp(
      { isReady: async () => true },
      {
        ...createAuthServiceForHttpTest(),
        async getProfile(sessionToken: string) {
          if (sessionToken !== "valid-session") {
            throw new AuthError(401, "Unauthenticated");
          }

          return {
            id: "user-1",
            name: "Ada Lovelace",
            rut: "123456785",
            email: "ada@example.test",
            username: "ada",
            isPlatformAdministrator: false,
            memberships: [
              {
                organization: {
                  id: "organization-a",
                  name: "Data Academy",
                  slug: "data-academy",
                },
                role: "ADMIN",
                permissions: NO_FLAGS,
                groups: [],
              },
              {
                organization: {
                  id: "organization-b",
                  name: "AI Academy",
                  slug: "ai-academy",
                },
                role: "USER",
                permissions: { ...NO_FLAGS, readInvoices: true },
                groups: [
                  {
                    group: { id: "group-1", name: "Finance" },
                    permissions: { ...NO_FLAGS, createInvoices: true },
                    effective: {
                      ...NO_FLAGS,
                      readInvoices: true,
                      createInvoices: true,
                    },
                  },
                ],
              },
            ],
          };
        },
        async updateProfile() {
          throw new Error("not used");
        },
      },
    );

    const response = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", "invoiceops_session=valid-session");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      profile: {
        mustChangePassword: false,
        id: "user-1",
        name: "Ada Lovelace",
        rut: "123456785",
        email: "ada@example.test",
        username: "ada",
        isPlatformAdministrator: false,
        memberships: [
          {
            organization: {
              id: "organization-a",
              name: "Data Academy",
              slug: "data-academy",
            },
            role: "ADMIN",
            permissions: NO_FLAGS,
            groups: [],
          },
          {
            organization: {
              id: "organization-b",
              name: "AI Academy",
              slug: "ai-academy",
            },
            role: "USER",
            permissions: { ...NO_FLAGS, readInvoices: true },
            groups: [
              {
                group: { id: "group-1", name: "Finance" },
                permissions: { ...NO_FLAGS, createInvoices: true },
                effective: {
                  ...NO_FLAGS,
                  readInvoices: true,
                  createInvoices: true,
                },
              },
            ],
          },
        ],
      },
    });
    expect(response.body.profile).not.toHaveProperty("contexts");
    expect(response.body.profile.id).toBe("user-1");
  });

  it("exposes platform administration status only from the authenticated profile", async () => {
    const app = createApp(
      { isReady: async () => true },
      {
        ...createAuthServiceForHttpTest(),
        async getProfile(sessionToken: string) {
          if (sessionToken !== "platform-session") {
            throw new AuthError(401, "Unauthenticated");
          }

          return {
            id: "platform-admin-1",
            name: "Ada Lovelace",
            rut: "123456785",
            email: null,
            username: null,
            isPlatformAdministrator: true,
            memberships: [],
          };
        },
      },
    );

    const response = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", "invoiceops_session=platform-session");

    expect(response.status).toBe(200);
    expect(response.body.profile.isPlatformAdministrator).toBe(true);
  });

  it("returns the same safe 401 for absent, invalid, and expired sessions", async () => {
    const app = createApp(
      { isReady: async () => true },
      {
        ...createAuthServiceForHttpTest(),
        async getProfile() {
          throw new AuthError(401, "Unauthenticated");
        },
        async updateProfile() {
          throw new AuthError(401, "Unauthenticated");
        },
      },
    );

    const absent = await request(app).get("/api/v1/auth/profile");
    const invalid = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", "invoiceops_session=invalid-session");
    const expired = await request(app)
      .get("/api/v1/auth/profile")
      .set("Cookie", "invoiceops_session=expired-session");

    expect(absent.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(expired.status).toBe(401);
    expect(absent.body).toEqual(invalid.body);
    expect(invalid.body).toEqual(expired.body);
  });

  it("updates only email and username and rejects sensitive mass assignment", async () => {
    const updates: unknown[] = [];
    const app = createApp(
      { isReady: async () => true },
      {
        ...createAuthServiceForHttpTest(),
        async getProfile() {
          throw new Error("not used");
        },
        async updateProfile(sessionToken: string, input: unknown) {
          if (sessionToken !== "valid-session") {
            throw new AuthError(401, "Unauthenticated");
          }

          updates.push(input);
          return {
            id: "user-1",
            name: "Ada Lovelace",
            rut: "123456785",
            email: "ada.updated@example.test",
            username: "ada-updated",
            isPlatformAdministrator: false,
            memberships: [],
          };
        },
      },
    );

    const updated = await request(app)
      .patch("/api/v1/profile")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=valid-session")
      .send({ email: "ada.updated@example.test", username: "ada-updated" });
    const rejected = await request(app)
      .patch("/api/v1/profile")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=valid-session")
      .send({ rut: "111111111", role: "ADMIN" });

    expect(updated.status).toBe(200);
    expect(updated.body.profile).toMatchObject({
      email: "ada.updated@example.test",
      username: "ada-updated",
      rut: "123456785",
    });
    expect(updates).toEqual([
      { email: "ada.updated@example.test", username: "ada-updated" },
    ]);
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid profile update",
        fields: { rut: "Unknown field", role: "Unknown field" },
      },
    });
  });

  it("rejects cookie-authenticated mutations from a different origin", async () => {
    const app = createApp(
      { isReady: async () => true },
      {
        ...createAuthServiceForHttpTest(),
        async updateProfile() {
          throw new Error("must not be called");
        },
      },
    );

    const response = await request(app)
      .patch("/api/v1/profile")
      .set("Cookie", "invoiceops_session=valid-session")
      .set("Origin", "https://untrusted.example.test")
      .send({ email: "ada@example.test" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: { code: "FORBIDDEN_ORIGIN", message: "Origin not allowed" },
    });
  });
});

describe("APP-04 groups HTTP contract", () => {
  const validOrigin = "http://127.0.0.1";
  const ORG = "organization-1";
  const STUDENT_ID = "5c9d2a1e-7b3f-4a8e-9d10-2f6b8c4e1a37";
  const FLAGS = {
    readInvoices: true,
    createInvoices: false,
    deleteOwnInvoices: false,
    deleteOthersInvoices: false,
  };
  const group = {
    id: "group-2",
    organizationId: ORG,
    name: "Advanced topics",
    description: null,
  };

  const unused = () => {
    throw new Error("not used");
  };

  function createGroupApp(groupOverrides: Partial<GroupService> = {}) {
    return createApp(
      { isReady: async () => true },
      {
        ...createAuthServiceForHttpTest(),
        async getProfile(sessionToken: string) {
          if (sessionToken !== "admin-session") {
            throw new AuthError(401, "Unauthenticated");
          }

          return {
            id: "admin-1",
            name: "Ada Lovelace",
            rut: "123456785",
            email: null,
            username: null,
            isPlatformAdministrator: false,
            memberships: [],
          };
        },
      },
      {
        groups: {
          async listGroups() {
            return [
              {
                id: "group-1",
                name: "Advanced topics",
                description: null,
                organization: { id: "organization-1", name: "AI Academy" },
              },
            ];
          },
        } satisfies GroupCatalogService,
        groupAdministration: {
          listGroups: unused,
          createGroup: unused,
          updateMemberPermissions: unused,
          listMemberships: unused,
          addMember: unused,
          addMembers: unused,
          updateMembersPermissions: unused,
          removeMember: unused,
          ...groupOverrides,
        } satisfies GroupService,
      },
    );
  }

  it("lists the authenticated user's groups without the people in them", async () => {
    const response = await request(createGroupApp())
      .get("/api/v1/groups")
      .set("Cookie", "invoiceops_session=admin-session");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      groups: [
        {
          id: "group-1",
          name: "Advanced topics",
          description: null,
          organization: { id: "organization-1", name: "AI Academy" },
        },
      ],
    });
  });

  it("serves the organization group list to the authenticated actor only", async () => {
    const listGroups = vi
      .fn<GroupService["listGroups"]>()
      .mockResolvedValue([group]);
    const app = createGroupApp({ listGroups });
    expect(
      (await request(app).get(`/api/v1/organizations/${ORG}/groups`)).status,
    ).toBe(401);
    const response = await request(app)
      .get(`/api/v1/organizations/${ORG}/groups`)
      .set("Cookie", "invoiceops_session=admin-session");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ groups: [group] });
    expect(listGroups).toHaveBeenCalledOnce();
    expect(listGroups).toHaveBeenCalledWith("admin-1", ORG);
  });

  it("creates a group on behalf of the session identity", async () => {
    const createGroup = vi
      .fn<GroupService["createGroup"]>()
      .mockResolvedValue(group);
    const response = await request(createGroupApp({ createGroup }))
      .post(`/api/v1/organizations/${ORG}/groups`)
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=admin-session")
      .send({ name: "Advanced topics" });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ group });
    expect(createGroup).toHaveBeenCalledWith("admin-1", ORG, {
      name: "Advanced topics",
    });
  });

  it("registers every group mutation with scoped IDs and its success contract", async () => {
    const calls: unknown[][] = [];
    const membership = {
      userId: "student-1",
      groupId: "group-2",
      organizationId: ORG,
      permissions: FLAGS,
    };
    const app = createGroupApp({
      async updateMemberPermissions(
        actorUserId,
        organizationId,
        groupId,
        memberId,
        permissions,
      ) {
        calls.push([
          "update",
          actorUserId,
          organizationId,
          groupId,
          memberId,
          permissions,
        ]);
        return membership;
      },
      async addMember(userId, organizationId, groupId, memberId, permissions) {
        calls.push([
          "add",
          userId,
          organizationId,
          groupId,
          memberId,
          permissions,
        ]);
        return membership;
      },
      async removeMember(userId, organizationId, groupId, memberId) {
        calls.push(["remove", userId, organizationId, groupId, memberId]);
      },
    });
    const updated = await request(app)
      .put(
        `/api/v1/organizations/${ORG}/groups/group-2/memberships/student-1/permissions`,
      )
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=admin-session")
      .send({ permissions: FLAGS });
    const added = await request(app)
      .post(`/api/v1/organizations/${ORG}/groups/group-2/memberships`)
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=admin-session")
      .send({ userId: STUDENT_ID });
    const removed = await request(app)
      .delete(
        `/api/v1/organizations/${ORG}/groups/group-2/memberships/student-1`,
      )
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=admin-session");

    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({ membership });
    expect(added.status).toBe(201);
    expect(added.body).toEqual({ membership });
    expect(removed.status).toBe(204);
    expect(calls).toEqual([
      ["update", "admin-1", ORG, "group-2", "student-1", FLAGS],
      ["add", "admin-1", ORG, "group-2", STUDENT_ID, undefined],
      ["remove", "admin-1", ORG, "group-2", "student-1"],
    ]);
  });

  it("rejects cross-origin requests before every group mutation handler", async () => {
    let invoked = 0;
    const fail = async () => {
      invoked += 1;
      throw new Error("must not be called");
    };
    const app = createGroupApp({
      createGroup: fail,
      updateMemberPermissions: fail,
      addMember: fail,
      removeMember: fail,
    });
    const responses = await Promise.all([
      request(app)
        .post(`/api/v1/organizations/${ORG}/groups`)
        .set("Cookie", "invoiceops_session=admin-session")
        .set("Origin", "https://untrusted.example.test")
        .send({ name: "Updated topics" }),
      request(app)
        .put(
          `/api/v1/organizations/${ORG}/groups/group-2/memberships/student-1/permissions`,
        )
        .set("Cookie", "invoiceops_session=admin-session")
        .set("Origin", "https://untrusted.example.test")
        .send({ permissions: FLAGS }),
      request(app)
        .post(`/api/v1/organizations/${ORG}/groups/group-2/memberships`)
        .set("Cookie", "invoiceops_session=admin-session")
        .set("Origin", "https://untrusted.example.test")
        .send({ userId: STUDENT_ID }),
      request(app)
        .delete(
          `/api/v1/organizations/${ORG}/groups/group-2/memberships/student-1`,
        )
        .set("Cookie", "invoiceops_session=admin-session")
        .set("Origin", "https://untrusted.example.test"),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body).toEqual({
        error: { code: "FORBIDDEN_ORIGIN", message: "Origin not allowed" },
      });
    }
    expect(invoked).toBe(0);
  });

  it("rejects unauthenticated mutations and maps authorized service errors", async () => {
    const app = createGroupApp({
      async addMember() {
        throw new AuthError(403, "Forbidden");
      },
    });

    const unauthenticated = await request(app)
      .put(
        `/api/v1/organizations/${ORG}/groups/group-2/memberships/student-1/permissions`,
      )
      .send({ permissions: FLAGS });
    const forbidden = await request(app)
      .post(`/api/v1/organizations/${ORG}/groups/group-2/memberships`)
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=admin-session")
      .send({ userId: STUDENT_ID });

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Unauthenticated" },
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({
      error: { code: "FORBIDDEN", message: "Forbidden" },
    });
  });
});

describe("organization membership HTTP contract", () => {
  const FLAGS = NO_FLAGS;

  it("uses the session identity for authorized discovery and preserves CSRF checks for membership changes", async () => {
    const calls: unknown[][] = [];
    const unused = () => {
      throw new Error("not used");
    };
    const app = createApp(
      { isReady: async () => true },
      {
        ...createAuthServiceForHttpTest(),
        async getProfile(sessionToken: string) {
          if (sessionToken !== "platform-session") {
            throw new AuthError(401, "Unauthenticated");
          }

          return {
            id: "platform-admin-1",
            name: "Ada Lovelace",
            rut: "123456785",
            email: null,
            username: null,
            isPlatformAdministrator: true,
            memberships: [],
          };
        },
      },
      {
        organizations: {
          createOrganization: unused,
          updateMembershipPermissions: unused,
          updateMembershipsPermissions: unused,
          getOrganization: unused,
          listMemberships: unused,
          listMembers: unused,
          updateOrganization: unused,
          async listOrganizations(actorUserId) {
            calls.push(["list", actorUserId]);
            return {
              organizations: [
                {
                  id: "organization-1",
                  name: "AI Academy",
                  slug: "ai-academy",
                  description: null,
                  enabled: true,
                  createdAt: "2026-10-26T00:00:00.000Z",
                },
              ],
              page: 1,
              pageSize: 20,
              total: 1,
            };
          },
          async createMembership(actorUserId, organizationId, input) {
            calls.push([
              "create",
              actorUserId,
              organizationId,
              input.rut,
              input.role,
            ]);
            return {
              userId: "student-1",
              organizationId,
              role: input.role,
              permissions: FLAGS,
            };
          },
          async changeMembershipRole(
            actorUserId,
            organizationId,
            userId,
            role,
          ) {
            calls.push(["change", actorUserId, organizationId, userId, role]);
            return {
              membership: { userId, organizationId, role, permissions: FLAGS },
              changed: true,
            };
          },
          async removeMembership(actorUserId, organizationId, userId) {
            calls.push(["remove", actorUserId, organizationId, userId]);
          },
        } satisfies OrganizationService,
      },
    );

    const discovered = await request(app)
      .get("/api/v1/organizations")
      .set("Cookie", "invoiceops_session=platform-session");
    const created = await request(app)
      .post("/api/v1/organizations/organization-1/memberships")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=platform-session")
      .send({ rut: "12.345.678-5", role: "ADMIN" });
    const changed = await request(app)
      .patch("/api/v1/organizations/organization-1/memberships/student-1")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=platform-session")
      .send({ role: "USER" });
    const removed = await request(app)
      .delete("/api/v1/organizations/organization-1/memberships/student-1")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=platform-session");
    const csrfRejected = await request(app)
      .post("/api/v1/organizations/organization-1/memberships")
      .set("Cookie", "invoiceops_session=platform-session")
      .set("Origin", "https://untrusted.example.test")
      .send({ rut: "12.345.678-5", role: "USER" });

    expect(discovered.status).toBe(200);
    expect(discovered.body).toEqual({
      organizations: [
        {
          id: "organization-1",
          name: "AI Academy",
          slug: "ai-academy",
          description: null,
          enabled: true,
          createdAt: "2026-10-26T00:00:00.000Z",
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    });
    expect(created.status).toBe(201);
    expect(changed.status).toBe(200);
    expect(removed.status).toBe(204);
    expect(csrfRejected.status).toBe(403);
    expect(calls).toEqual([
      ["list", "platform-admin-1"],
      ["create", "platform-admin-1", "organization-1", "123456785", "ADMIN"],
      ["change", "platform-admin-1", "organization-1", "student-1", "USER"],
      ["remove", "platform-admin-1", "organization-1", "student-1"],
    ]);
  });
});
