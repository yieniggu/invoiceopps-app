import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { AuthError, type AuthService } from "../src/auth.js";
import type {
  BusinessPolicy,
  BusinessPolicyService,
} from "../src/business-policies.js";

const context = {
  organizationId: "organization-1",
  ownerType: "user" as const,
  ownerId: "user-1",
};
const validOrigin = "http://127.0.0.1";

function createAuth(): AuthService {
  return {
    async signUp() {
      throw new Error("not used");
    },
    async login() {
      throw new Error("not used");
    },
    async logout() {
      throw new Error("not used");
    },
    async getProfile(sessionToken) {
      if (sessionToken !== "valid-session") {
        throw new AuthError(401, "Unauthorized");
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
  };
}

function createPolicyApp(overrides: Partial<BusinessPolicyService> = {}) {
  const policy: BusinessPolicy = {
    version: "ml-policy-v1",
    manualReviewThreshold: 0.8,
  };
  return createApp({ isReady: async () => true }, createAuth(), {
    businessPolicies: {
      async listPolicies(userId, receivedContext) {
        expect(userId).toBe("user-1");
        expect(receivedContext).toEqual(context);
        return [policy];
      },
      async createPolicy(userId, receivedContext, input) {
        expect(userId).toBe("user-1");
        expect(receivedContext).toEqual(context);
        return input;
      },
      async updatePolicy(userId, receivedContext, version, input) {
        expect(userId).toBe("user-1");
        expect(receivedContext).toEqual(context);
        return { version, ...input };
      },
      ...overrides,
    } satisfies BusinessPolicyService,
  });
}

function withContext(path: string) {
  return `${path}?${new URLSearchParams(context)}`;
}

describe("APP-07 BusinessPolicy HTTP contract", () => {
  it("lists, creates, and updates policies in the authenticated context", async () => {
    const app = createPolicyApp();
    const listed = await request(app)
      .get(withContext("/business-policies"))
      .set("Cookie", "invoiceops_session=valid-session");
    const created = await request(app)
      .post(withContext("/business-policies"))
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=valid-session")
      .send({ version: " ml-policy-v2 ", manualReviewThreshold: 0 });
    const updated = await request(app)
      .patch(withContext("/business-policies/ml-policy-v2"))
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=valid-session")
      .send({ manualReviewThreshold: 1 });

    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      policies: [{ version: "ml-policy-v1", manualReviewThreshold: 0.8 }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      policy: { version: "ml-policy-v2", manualReviewThreshold: 0 },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({
      policy: { version: "ml-policy-v2", manualReviewThreshold: 1 },
    });
  });

  it("rejects unauthenticated requests and preserves safe context denials", async () => {
    const app = createPolicyApp({
      async listPolicies() {
        throw new AuthError(404, "Business policy not found");
      },
      async createPolicy() {
        throw new AuthError(404, "Business policy not found");
      },
      async updatePolicy() {
        throw new AuthError(404, "Business policy not found");
      },
    });
    const unauthenticated = await request(app).get(
      withContext("/business-policies"),
    );
    const crossOwner = await request(app)
      .get(
        `/business-policies?${new URLSearchParams({
          ...context,
          ownerId: "other-user",
        })}`,
      )
      .set("Cookie", "invoiceops_session=valid-session");
    const crossOrganization = await request(app)
      .post(
        `/business-policies?${new URLSearchParams({
          ...context,
          organizationId: "organization-2",
        })}`,
      )
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=valid-session")
      .send({ version: "ml-policy-v1", manualReviewThreshold: 0.8 });

    expect(unauthenticated.status).toBe(401);
    expect(crossOwner.status).toBe(404);
    expect(crossOrganization.status).toBe(404);
    expect(crossOwner.body).toEqual({
      status: "error",
      message: "Business policy not found",
    });
  });

  it("enforces CSRF for cookie-authenticated policy mutations before services run", async () => {
    let invoked = 0;
    const app = createPolicyApp({
      async createPolicy() {
        invoked += 1;
        throw new Error("must not be called");
      },
      async updatePolicy() {
        invoked += 1;
        throw new Error("must not be called");
      },
    });
    const responses = await Promise.all([
      request(app)
        .post(withContext("/business-policies"))
        .set("Cookie", "invoiceops_session=valid-session")
        .send({ version: "ml-policy-v1", manualReviewThreshold: 0.8 }),
      request(app)
        .patch(withContext("/business-policies/ml-policy-v1"))
        .set("Cookie", "invoiceops_session=valid-session")
        .set("Origin", "https://untrusted.example.test")
        .send({ manualReviewThreshold: 0.8 }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ status: "error", message: "Forbidden" });
    }
    expect(invoked).toBe(0);
  });

  it("validates policy versions and threshold bounds without calling services", async () => {
    let invoked = 0;
    const app = createPolicyApp({
      async createPolicy() {
        invoked += 1;
        throw new Error("must not be called");
      },
      async updatePolicy() {
        invoked += 1;
        throw new Error("must not be called");
      },
    });
    const invalidPayloads = [
      { version: "ml-policy-v1", manualReviewThreshold: -0.01 },
      { version: "ml-policy-v1", manualReviewThreshold: 1.01 },
      { version: "", manualReviewThreshold: 0.8 },
      { manualReviewThreshold: 0.8 },
    ];
    const responses = await Promise.all(
      invalidPayloads.map((body) =>
        request(app)
          .post(withContext("/business-policies"))
          .set("Host", "127.0.0.1")
          .set("Origin", validOrigin)
          .set("Cookie", "invoiceops_session=valid-session")
          .send(body),
      ),
    );
    const invalidPatch = await request(app)
      .patch(withContext("/business-policies/ml-policy-v1"))
      .set("Host", "127.0.0.1")
      .set("Origin", validOrigin)
      .set("Cookie", "invoiceops_session=valid-session")
      .send({ manualReviewThreshold: -1 });

    for (const response of [...responses, invalidPatch]) {
      expect(response.status).toBe(400);
    }
    expect(invoked).toBe(0);
  });
});
