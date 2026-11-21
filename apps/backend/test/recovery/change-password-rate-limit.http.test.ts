import { describe, expect, it, vi } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import { createAuthRateLimiter } from "../../src/auth-rate-limit.js";
import { AuthError, type AuthService } from "../../src/auth.js";

const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const BODY = {
  currentPassword: "wrong-guess-1",
  newPassword: "next-password-12",
};

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

function build(changePassword: AuthService["changePassword"], max = 3) {
  const auth: AuthService = {
    async login() {
      return {
        sessionToken: "s",
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
    changePassword,
  };
  return createApp({ isReady: async () => true }, auth, {
    authRateLimiter: createAuthRateLimiter({ maxAttempts: max }),
  });
}

const change = (
  app: ReturnType<typeof build>,
  session = "session-a",
  body: object = BODY,
) =>
  request(app)
    .post("/api/v1/auth/change-password")
    .set(SAME_ORIGIN)
    .set("Cookie", `invoiceops_session=${session}`)
    .send(body);

const wrongPassword = async () => {
  throw new AuthError(
    400,
    "The current password is incorrect.",
    "INVALID_CURRENT_PASSWORD",
  );
};

describe("POST /auth/change-password rate limit (CR-511)", () => {
  it("answers 429 after N wrong current passwords of one session and stops calling the service", async () => {
    const changePassword = vi.fn(wrongPassword);
    const app = build(changePassword, 3);

    for (let index = 0; index < 3; index += 1) {
      const response = await change(app);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("INVALID_CURRENT_PASSWORD");
    }
    const blocked = await change(app);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(changePassword).toHaveBeenCalledTimes(3);
  });

  it("limits each session on its own", async () => {
    const app = build(vi.fn(wrongPassword), 2);
    await change(app, "session-a");
    await change(app, "session-a");
    expect((await change(app, "session-a")).status).toBe(429);
    expect((await change(app, "session-b")).status).toBe(400);
  });

  it("does not charge validation errors, success or a stale session", async () => {
    let outcome: "ok" | "stale" = "stale";
    const app = build(async () => {
      if (outcome === "stale") throw new AuthError(401, "Unauthenticated");
      return { sessionToken: "rotated" };
    }, 2);

    for (let index = 0; index < 5; index += 1) {
      expect(
        (await change(app, "session-a", { currentPassword: "x" })).status,
      ).toBe(400);
      expect((await change(app)).status).toBe(401);
    }
    outcome = "ok";
    for (let index = 0; index < 5; index += 1) {
      expect((await change(app)).status).toBe(204);
    }
  });

  it("a success clears the wrong guesses made before it", async () => {
    let correct = false;
    const app = build(async () => {
      if (!correct) return wrongPassword();
      return { sessionToken: "rotated" };
    }, 3);
    await change(app);
    await change(app);
    correct = true;
    expect((await change(app)).status).toBe(204);
    correct = false;
    // The budget starts over: three more wrong guesses before the block.
    for (let index = 0; index < 3; index += 1) {
      expect((await change(app)).status).toBe(400);
    }
    expect((await change(app)).status).toBe(429);
  });
});
