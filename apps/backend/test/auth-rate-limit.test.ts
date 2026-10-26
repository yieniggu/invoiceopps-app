import { describe, expect, it } from "vitest";

import {
  authRateLimitConfigFromEnv,
  createAuthRateLimiterFromConfig,
} from "../src/auth-rate-limit.js";

describe("authRateLimitConfigFromEnv", () => {
  it("uses defaults when nothing is configured", () => {
    expect(authRateLimitConfigFromEnv({})).toEqual({
      disabled: false,
      maxAttempts: 5,
      windowMs: 15 * 60 * 1000,
    });
  });

  it("reads custom values", () => {
    expect(
      authRateLimitConfigFromEnv({
        AUTH_RATE_LIMIT_MAX_ATTEMPTS: "50",
        AUTH_RATE_LIMIT_WINDOW_MS: "1000",
      }),
    ).toEqual({ disabled: false, maxAttempts: 50, windowMs: 1000 });
  });

  it("disables only with the literal value true", () => {
    expect(
      authRateLimitConfigFromEnv({ AUTH_RATE_LIMIT_DISABLED: "true" }),
    ).toEqual({
      disabled: true,
    });
    expect(
      authRateLimitConfigFromEnv({ AUTH_RATE_LIMIT_DISABLED: "false" }),
    ).toMatchObject({ disabled: false });
  });

  it.each(["0", "-1", "1.5", "abc", "1e3", "99999999999999999999"])(
    "rejects invalid number %j",
    (value) => {
      expect(() =>
        authRateLimitConfigFromEnv({ AUTH_RATE_LIMIT_MAX_ATTEMPTS: value }),
      ).toThrow("AUTH_RATE_LIMIT_MAX_ATTEMPTS must be a positive integer");
      expect(() =>
        authRateLimitConfigFromEnv({ AUTH_RATE_LIMIT_WINDOW_MS: value }),
      ).toThrow("AUTH_RATE_LIMIT_WINDOW_MS must be a positive integer");
    },
  );

  it("refuses to disable in production", () => {
    expect(() =>
      authRateLimitConfigFromEnv({
        AUTH_RATE_LIMIT_DISABLED: "true",
        NODE_ENV: "production",
      }),
    ).toThrow("AUTH_RATE_LIMIT_DISABLED is not allowed in production");
  });

  it("builds a limiter that always allows when disabled", () => {
    const limiter = createAuthRateLimiterFromConfig({ disabled: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(limiter.allow("127.0.0.1")).toBe(true);
    }
  });
});
