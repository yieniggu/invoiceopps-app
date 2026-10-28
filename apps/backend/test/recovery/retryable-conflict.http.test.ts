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

const FLAGS = {
  readInvoices: true,
  createInvoices: true,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
};

// Every serializable transaction loses to a concurrent writer (Prisma P2034).
// The authority reads that run before the transaction (user provisioning checks
// it before hashing the password) answer "authorized".
function conflictingPrisma() {
  const attempts = { count: 0 };
  const prisma = {
    platformAdministrator: {
      findUnique: async () => ({ userId: "user-1" }),
    },
    organizationMembership: {
      findUnique: async () => ({ role: "ADMIN" }),
    },
    $transaction: async () => {
      attempts.count += 1;
      throw Object.assign(new Error("write conflict"), { code: "P2034" });
    },
  };
  return { prisma, attempts };
}

const OPERATIONS = [
  [
    "post",
    `/organizations/${ORG}/memberships`,
    { rut: "123456785", role: "USER" },
  ],
  ["patch", `/organizations/${ORG}/memberships/${USER}`, { role: "ADMIN" }],
  ["delete", `/organizations/${ORG}/memberships/${USER}`, undefined],
  [
    "put",
    `/organizations/${ORG}/memberships/permissions`,
    { userIds: [USER], permissions: FLAGS },
  ],
  [
    "put",
    `/organizations/${ORG}/memberships/${USER}/permissions`,
    {
      permissions: {
        readInvoices: true,
        createInvoices: true,
        deleteOwnInvoices: false,
        deleteOthersInvoices: false,
      },
    },
  ],
  [
    "put",
    `/organizations/${ORG}/groups/${GROUP}/memberships/${USER}/permissions`,
    {
      permissions: {
        readInvoices: true,
        createInvoices: true,
        deleteOwnInvoices: false,
        deleteOthersInvoices: false,
      },
    },
  ],
  [
    "post",
    `/organizations/${ORG}/groups/${GROUP}/memberships`,
    { userId: USER },
  ],
  [
    "post",
    `/organizations/${ORG}/groups/${GROUP}/memberships/bulk`,
    { members: [{ userId: USER, permissions: FLAGS }] },
  ],
  [
    "put",
    `/organizations/${ORG}/groups/${GROUP}/memberships/permissions`,
    { userIds: [USER], permissions: FLAGS },
  ],
  [
    "delete",
    `/organizations/${ORG}/groups/${GROUP}/memberships/${USER}`,
    undefined,
  ],
  [
    "post",
    `/organizations/${ORG}/users`,
    { name: "Ada", rut: "123456785", role: "USER" },
  ],
  ["post", "/admin/users", { name: "Ada", rut: "123456785", memberships: [] }],
] as const;

describe("CR-102 exhausted serialization retries over HTTP", () => {
  it.each(OPERATIONS)(
    "answers %s %s with 503 RETRYABLE_CONFLICT and Retry-After",
    async (method, path, body) => {
      const { prisma, attempts } = conflictingPrisma();
      const app = createApp(
        { isReady: async () => true, prisma: prisma as never },
        auth,
      );

      const agent = request(app);
      const call = agent[method](`/api/v1${path}`)
        .set(SAME_ORIGIN)
        .set("Cookie", COOKIE);
      const response = await (body ? call.send(body) : call);

      expect(response.status).toBe(503);
      expect(response.headers["retry-after"]).toBe("1");
      expect(response.body).toEqual({
        error: {
          code: "RETRYABLE_CONFLICT",
          message: "The operation conflicted with a concurrent change; retry",
        },
      });
      expect(attempts.count).toBe(3);
    },
  );
});
