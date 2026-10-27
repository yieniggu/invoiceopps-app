import request from "../support/request.js";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ORG = "11111111-1111-4111-8111-111111111111";
const GROUP = "33333333-3333-4333-8333-333333333333";
const USER = "22222222-2222-4222-8222-222222222222";

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

function fakeAuth(mustChangePassword = false): AuthService {
  return {
    async login() {
      return {
        sessionToken: "opaque-session-token",
        user: { id: "user-1", name: "Ada", rut: "123456785" },
      };
    },
    async logout() {},
    async getProfile() {
      return { ...profile, mustChangePassword };
    },
    async updateProfile() {
      return profile;
    },
    async changePassword() {
      return { sessionToken: "rotated-session-token" };
    },
  };
}

const buildApp = (auth?: AuthService) =>
  createApp({ isReady: async () => true }, auth);

const OPERATIONS = [
  ["get", `/organizations/${ORG}/groups`],
  ["post", `/organizations/${ORG}/groups`],
  ["patch", `/organizations/${ORG}/groups/${GROUP}`],
  ["get", `/organizations/${ORG}/groups/${GROUP}/memberships`],
  ["post", `/organizations/${ORG}/groups/${GROUP}/memberships`],
  ["delete", `/organizations/${ORG}/groups/${GROUP}/memberships/${USER}`],
] as const;

describe("RP0-07 group routes over HTTP", () => {
  it.each(OPERATIONS)(
    "answers %s %s without a session with 401",
    async (method, path) => {
      const agent = request(buildApp(fakeAuth()));
      const response = await agent[method](`/api/v1${path}`).set(SAME_ORIGIN);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHENTICATED");
    },
  );

  it.each(OPERATIONS)(
    "blocks %s %s with ONBOARDING_REQUIRED while a temporary password is pending",
    async (method, path) => {
      const agent = request(buildApp(fakeAuth(true)));
      const response = await agent[method](`/api/v1${path}`)
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("ONBOARDING_REQUIRED");
    },
  );

  it.each(OPERATIONS)(
    "keeps the Origin check on cookie write %s %s",
    async (method, path) => {
      if (method === "get") return;
      const agent = request(buildApp(fakeAuth()));
      const response = await agent[method](`/api/v1${path}`)
        .set("Host", "127.0.0.1")
        .set("Origin", "http://evil.example")
        .set("Cookie", COOKIE);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN_ORIGIN");
    },
  );

  it.each([
    ["delete", `/organizations/${ORG}/groups/${GROUP}`],
    ["post", `/organizations/${ORG}/groups/${GROUP}/members`],
    ["delete", `/organizations/${ORG}/groups/${GROUP}/members/${USER}`],
  ] as const)(
    "no longer serves the legacy %s /api/v1%s",
    async (method, path) => {
      const agent = request(buildApp(fakeAuth()));
      const response = await agent[method](`/api/v1${path}`)
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
    },
  );
});
