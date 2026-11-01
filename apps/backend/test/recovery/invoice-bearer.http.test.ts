import { describe, expect, it } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";

const COOKIE = "invoiceops_session=session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "iop_not-a-real-secret";

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

const auth: AuthService = {
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
};

const app = () => createApp({ isReady: async () => true }, auth);

describe("Bearer is limited to the four invoice operations (AC-08)", () => {
  it.each([
    ["get", "/api/v1/auth/profile"],
    ["post", "/api/v1/auth/logout"],
    ["post", "/api/v1/auth/change-password"],
    ["patch", "/api/v1/auth/profile"],
    ["get", "/api/v1/organizations"],
    ["get", `/api/v1/organizations/${ORG}/memberships`],
    ["put", `/api/v1/organizations/${ORG}/memberships/${ID}/permissions`],
    ["get", "/api/v1/admin/users"],
    ["post", "/api/v1/admin/users"],
    ["post", `/api/v1/admin/users/${ID}/deactivation`],
  ] as const)("answers 401 to Bearer on %s %s", async (method, path) => {
    const agent = request(app());
    const response = await agent[method](path)
      .set("Authorization", `Bearer ${SECRET}`)
      .send({});

    expect(response.status).toBe(401);
  });

  it.each([
    ["post", "/api/v1/invoices"],
    ["get", `/api/v1/invoices?organizationId=${ORG}`],
    ["get", `/api/v1/invoices/${ID}?organizationId=${ORG}`],
    ["delete", `/api/v1/invoices/${ID}?organizationId=${ORG}`],
  ] as const)(
    "answers 400 AMBIGUOUS_AUTH to Bearer plus cookie on %s %s",
    async (method, path) => {
      const agent = request(app());
      const response = await agent[method](path)
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE)
        .set("Authorization", `Bearer ${SECRET}`)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("AMBIGUOUS_AUTH");
    },
  );
});

describe("malformed Authorization headers never authenticate (SUP-2)", () => {
  it.each([
    ["a Basic scheme", "Basic dXNlcjpwYXNz"],
    ["Bearer without a value", "Bearer"],
    ["Bearer with only a space", "Bearer "],
    ["Bearer with two values", "Bearer one two"],
    ["a lowercase unknown scheme", "Token iop_abc"],
  ])("answers 401 for %s on the invoice list", async (_label, header) => {
    const response = await request(app())
      .get(`/api/v1/invoices?organizationId=${ORG}`)
      .set("Authorization", header);

    expect(response.status).toBe(401);
  });
});
