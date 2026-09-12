import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { createAuthRateLimiter } from "../src/auth-rate-limit.js";
import { AuthError, createAuthService, type AuthService } from "../src/auth.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import type { GroupService } from "../src/groups.js";

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

  it("revokes only the current session and clears its compatible cookie", async () => {
    const activeSessions = new Set(["current-session", "other-session"]);
    const app = createApp(
      { isReady: async () => true },
      {
        ...createAuthServiceForHttpTest(),
        async logout(sessionToken: string) {
          if (!activeSessions.delete(sessionToken)) {
            throw new AuthError(401, "Unauthorized");
          }
        },
        async getProfile(sessionToken: string) {
          if (!activeSessions.has(sessionToken)) {
            throw new AuthError(401, "Unauthorized");
          }

          return {
            id: "user-1",
            name: "Ada Lovelace",
            rut: "123456785",
            email: null,
            username: null,
            memberships: [],
          };
        },
        async updateProfile() {
          throw new Error("not used");
        },
      },
    );

    const logout = await request(app)
      .post("/auth/logout")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=current-session");
    const revokedProfile = await request(app)
      .get("/profile")
      .set("Cookie", "invoiceops_session=current-session");
    const otherProfile = await request(app)
      .get("/profile")
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
          throw new AuthError(401, "Unauthorized");
        },
      },
    );

    const absent = await request(app).post("/auth/logout");
    const invalid = await request(app)
      .post("/auth/logout")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=invalid-session");
    const expired = await request(app)
      .post("/auth/logout")
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

describe("APP-03 profile HTTP contract", () => {
  it("returns the authenticated profile and deterministically ordered memberships", async () => {
    const app = createApp(
      { isReady: async () => true },
      {
        ...createAuthServiceForHttpTest(),
        async getProfile(sessionToken: string) {
          if (sessionToken !== "valid-session") {
            throw new AuthError(401, "Unauthorized");
          }

          return {
            id: "user-1",
            name: "Ada Lovelace",
            rut: "123456785",
            email: "ada@example.test",
            username: "ada",
            memberships: [
              {
                organization: {
                  id: "organization-a",
                  name: "Data Academy",
                  slug: "data-academy",
                },
                role: "ADMIN",
              },
              {
                organization: {
                  id: "organization-b",
                  name: "AI Academy",
                  slug: "ai-academy",
                },
                role: "STUDENT",
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
      .get("/profile")
      .set("Cookie", "invoiceops_session=valid-session");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      profile: {
        name: "Ada Lovelace",
        rut: "123456785",
        email: "ada@example.test",
        username: "ada",
        memberships: [
          {
            organization: {
              id: "organization-a",
              name: "Data Academy",
              slug: "data-academy",
            },
            role: "ADMIN",
          },
          {
            organization: {
              id: "organization-b",
              name: "AI Academy",
              slug: "ai-academy",
            },
            role: "STUDENT",
          },
        ],
      },
    });
    expect(response.body).not.toHaveProperty("id");
  });

  it("returns the same safe 401 for absent, invalid, and expired sessions", async () => {
    const app = createApp(
      { isReady: async () => true },
      {
        ...createAuthServiceForHttpTest(),
        async getProfile() {
          throw new AuthError(401, "Unauthorized");
        },
        async updateProfile() {
          throw new AuthError(401, "Unauthorized");
        },
      },
    );

    const absent = await request(app).get("/profile");
    const invalid = await request(app)
      .get("/profile")
      .set("Cookie", "invoiceops_session=invalid-session");
    const expired = await request(app)
      .get("/profile")
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
            throw new AuthError(401, "Unauthorized");
          }

          updates.push(input);
          return {
            id: "user-1",
            name: "Ada Lovelace",
            rut: "123456785",
            email: "ada.updated@example.test",
            username: "ada-updated",
            memberships: [],
          };
        },
      },
    );

    const updated = await request(app)
      .patch("/profile")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set("Cookie", "invoiceops_session=valid-session")
      .send({ email: "ada.updated@example.test", username: "ada-updated" });
    const rejected = await request(app)
      .patch("/profile")
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
      status: "error",
      message: "Invalid profile update",
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
      .patch("/profile")
      .set("Cookie", "invoiceops_session=valid-session")
      .set("Origin", "https://untrusted.example.test")
      .send({ email: "ada@example.test" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ status: "error", message: "Forbidden" });
  });
});

describe("APP-04 groups HTTP contract", () => {
  const validOrigin = "http://127.0.0.1";

  function createGroupApp(groupOverrides: Partial<GroupService> = {}) {
    return createApp(
      { isReady: async () => true },
      {
        ...createAuthServiceForHttpTest(),
        async getProfile(sessionToken: string) {
          if (sessionToken !== "admin-session") {
            throw new AuthError(401, "Unauthorized");
          }

          return {
            id: "admin-1",
            name: "Ada Lovelace",
            rut: "123456785",
            email: null,
            username: null,
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
                members: [
                  {
                    id: "student-1",
                    name: "Grace Hopper",
                    rut: "123456793",
                  },
                ],
              },
            ];
          },
          async createGroup(_userId, organizationId, input) {
            return {
              id: "created-group",
              name: input.name,
              description: input.description ?? null,
              organization: { id: organizationId, name: "AI Academy" },
              members: [],
            };
          },
          async updateGroup() {
            throw new Error("not used");
          },
          async deleteGroup() {
            throw new Error("not used");
          },
          async addMember() {
            throw new Error("not used");
          },
          async removeMember() {
            throw new Error("not used");
          },
          ...groupOverrides,
        } satisfies GroupService,
      },
    );
  }

  it("lists the authenticated user's groups with deterministic members", async () => {
    const response = await request(createGroupApp())
      .get("/groups")
      .set("Cookie", "invoiceops_session=admin-session");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      groups: [
        {
          id: "group-1",
          name: "Advanced topics",
          description: null,
          organization: { id: "organization-1", name: "AI Academy" },
          members: [
            { id: "student-1", name: "Grace Hopper", rut: "123456793" },
          ],
        },
      ],
    });
  });

  it("allows only an organization ADMIN to create a group", async () => {
    const response = await request(createGroupApp())
      .post("/organizations/organization-1/groups")
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=admin-session")
      .send({ name: "Advanced topics" });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      group: {
        id: expect.any(String),
        name: "Advanced topics",
        organization: { id: "organization-1" },
      },
    });
  });

  it("registers every group mutation with scoped IDs and its success contract", async () => {
    const calls: unknown[][] = [];
    const group = {
      id: "group-2",
      name: "Updated topics",
      description: "Current curriculum",
      organization: { id: "organization-1", name: "AI Academy" },
      members: [{ id: "student-1", name: "Grace Hopper", rut: "123456793" }],
    };
    const app = createGroupApp({
      async updateGroup(userId, organizationId, groupId, input) {
        calls.push(["update", userId, organizationId, groupId, input]);
        return group;
      },
      async deleteGroup(userId, organizationId, groupId) {
        calls.push(["delete", userId, organizationId, groupId]);
      },
      async addMember(userId, organizationId, groupId, memberId) {
        calls.push(["add", userId, organizationId, groupId, memberId]);
        return group;
      },
      async removeMember(userId, organizationId, groupId, memberId) {
        calls.push(["remove", userId, organizationId, groupId, memberId]);
      },
    });
    const updated = await request(app)
      .patch("/organizations/organization-1/groups/group-2")
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=admin-session")
      .send({ name: " Updated topics ", description: " Current curriculum " });
    const added = await request(app)
      .post("/organizations/organization-1/groups/group-2/members")
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=admin-session")
      .send({ userId: " student-1 " });
    const removed = await request(app)
      .delete("/organizations/organization-1/groups/group-2/members/student-1")
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=admin-session");
    const deleted = await request(app)
      .delete("/organizations/organization-1/groups/group-2")
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=admin-session");

    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({ group });
    expect(added.status).toBe(200);
    expect(added.body).toEqual({ group });
    expect(removed.status).toBe(204);
    expect(deleted.status).toBe(204);
    expect(calls).toEqual([
      [
        "update",
        "admin-1",
        "organization-1",
        "group-2",
        { name: "Updated topics", description: "Current curriculum" },
      ],
      ["add", "admin-1", "organization-1", "group-2", "student-1"],
      ["remove", "admin-1", "organization-1", "group-2", "student-1"],
      ["delete", "admin-1", "organization-1", "group-2"],
    ]);
  });

  it("rejects cross-origin requests before every group mutation handler", async () => {
    let invoked = 0;
    const app = createGroupApp({
      async updateGroup() {
        invoked += 1;
        throw new Error("must not be called");
      },
      async deleteGroup() {
        invoked += 1;
        throw new Error("must not be called");
      },
      async addMember() {
        invoked += 1;
        throw new Error("must not be called");
      },
      async removeMember() {
        invoked += 1;
        throw new Error("must not be called");
      },
    });
    const responses = await Promise.all([
      request(app)
        .patch("/organizations/organization-1/groups/group-2")
        .set("Cookie", "invoiceops_session=admin-session")
        .set("Origin", "https://untrusted.example.test")
        .send({ name: "Updated topics" }),
      request(app)
        .delete("/organizations/organization-1/groups/group-2")
        .set("Cookie", "invoiceops_session=admin-session")
        .set("Origin", "https://untrusted.example.test"),
      request(app)
        .post("/organizations/organization-1/groups/group-2/members")
        .set("Cookie", "invoiceops_session=admin-session")
        .set("Origin", "https://untrusted.example.test")
        .send({ userId: "student-1" }),
      request(app)
        .delete(
          "/organizations/organization-1/groups/group-2/members/student-1",
        )
        .set("Cookie", "invoiceops_session=admin-session")
        .set("Origin", "https://untrusted.example.test"),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ status: "error", message: "Forbidden" });
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
      .patch("/organizations/organization-1/groups/group-2")
      .send({ name: "Updated topics" });
    const forbidden = await request(app)
      .post("/organizations/organization-1/groups/group-2/members")
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=admin-session")
      .send({ userId: "student-1" });

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toEqual({
      status: "error",
      message: "Unauthorized",
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({ status: "error", message: "Forbidden" });
  });
});
