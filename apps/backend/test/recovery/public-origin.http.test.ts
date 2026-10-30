import request from "../support/request.js";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import type { AuthService } from "../../src/auth.js";

const COOKIE = "invoiceops_session=session-token";
const PUBLIC_ORIGIN = "https://invoiceops.aglai.dev";

function fakeAuth(): AuthService {
  return {
    async login() {
      throw new Error("not used");
    },
    async logout() {},
    async getProfile() {
      return {
        id: "user-1",
        name: "Ada",
        rut: "123456785",
        email: null,
        username: null,
        mustChangePassword: false,
        isPlatformAdministrator: false,
        memberships: [],
      };
    },
    async updateProfile() {
      throw new Error("not used");
    },
    async changePassword() {},
  };
}

function buildApp(publicOrigin?: string) {
  return createApp({ isReady: async () => true }, fakeAuth(), {
    trustProxyHops: 1,
    publicOrigin,
  });
}

function logout(app: ReturnType<typeof buildApp>) {
  return request(app).post("/api/v1/auth/logout").set("Cookie", COOKIE);
}

describe("PUBLIC_ORIGIN cookie-write origin check", () => {
  it("accepts the public origin although the proxy hop says http and another host", async () => {
    const response = await logout(buildApp(PUBLIC_ORIGIN))
      .set("Host", "invoiceops-web")
      .set("X-Forwarded-Proto", "http")
      .set("Origin", PUBLIC_ORIGIN);

    expect(response.status).toBe(204);
  });

  it("rejects a foreign origin", async () => {
    const response = await logout(buildApp(PUBLIC_ORIGIN))
      .set("Host", "invoiceops.aglai.dev")
      .set("X-Forwarded-Proto", "https")
      .set("Origin", "https://evil.example");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("rejects a missing Origin", async () => {
    const response = await logout(buildApp(PUBLIC_ORIGIN))
      .set("Host", "invoiceops.aglai.dev")
      .set("X-Forwarded-Proto", "https");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it.each([
    ["http scheme of the public host", "http://invoiceops.aglai.dev"],
    ["a different port", "https://invoiceops.aglai.dev:8443"],
    ["a subdomain", "https://x.invoiceops.aglai.dev"],
    ["the literal null origin", "null"],
  ])(
    "rejects %s even with spoofed Host and X-Forwarded-Proto",
    async (_n, origin) => {
      const response = await logout(buildApp(PUBLIC_ORIGIN))
        .set("Host", new URL(origin === "null" ? "http://a" : origin).host)
        .set("X-Forwarded-Proto", origin.startsWith("https") ? "https" : "http")
        .set("Origin", origin);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN_ORIGIN");
    },
  );

  it("keeps the Host-derived check when PUBLIC_ORIGIN is unset", async () => {
    const app = buildApp();
    const ok = await logout(app)
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1");
    const bad = await logout(app)
      .set("Host", "127.0.0.1")
      .set("Origin", PUBLIC_ORIGIN);

    expect(ok.status).toBe(204);
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe("FORBIDDEN_ORIGIN");
  });
});
