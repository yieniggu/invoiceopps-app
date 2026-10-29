import request from "../support/request.js";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";

// CR-310: PATCH /api/v1/profile validates the contact data before the service.
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

function harness() {
  const updateProfile = vi.fn(
    async (_token: string, _input: object) => profile,
  );
  const auth = {
    login: vi.fn(),
    logout: vi.fn(),
    getProfile: vi.fn(async () => profile),
    updateProfile,
  } as unknown as AuthService;
  const app = createApp({ isReady: async () => true }, auth);
  const patch = (body: unknown) =>
    request(app)
      .patch("/api/v1/profile")
      .set(SAME_ORIGIN)
      .set("Cookie", COOKIE)
      .send(body as object);
  return { patch, updateProfile };
}

describe("PATCH /api/v1/profile validation (CR-310)", () => {
  it.each([
    ["NUL in email", { email: "a\u0000@example.test" }],
    ["NUL in username", { username: "ada\u0000" }],
    ["email of 255 characters", { email: `${"a".repeat(243)}@example.test` }],
    ["username of 65 characters", { username: "u".repeat(65) }],
    ["email without @", { email: "not-an-email" }],
    ["email with spaces inside", { email: "ada lovelace@example.test" }],
    ["email without a domain", { email: "ada@" }],
    ["email of the wrong type", { email: 5 }],
    ["username of the wrong type", { username: 5 }],
  ])(
    "rejects %s with 400 VALIDATION_ERROR before the service",
    async (_l, body) => {
      const h = harness();
      const response = await h.patch(body);
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(h.updateProfile).not.toHaveBeenCalled();
    },
  );

  it("trims, lowercases the email and stores blank values as null", async () => {
    const h = harness();
    expect(
      (await h.patch({ email: "  Ada@Example.Test ", username: "  ada  " }))
        .status,
    ).toBe(200);
    expect((await h.patch({ email: "   ", username: "" })).status).toBe(200);
    expect((await h.patch({ email: null, username: null })).status).toBe(200);
    expect(h.updateProfile.mock.calls.map((call) => call[1])).toEqual([
      { email: "ada@example.test", username: "ada" },
      { email: null, username: null },
      { email: null, username: null },
    ]);
  });

  it("accepts the maximum lengths", async () => {
    const h = harness();
    const email = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(55)}.test`;
    expect(email.length).toBeLessThanOrEqual(254);
    expect((await h.patch({ email, username: "u".repeat(64) })).status).toBe(
      200,
    );
  });
});
