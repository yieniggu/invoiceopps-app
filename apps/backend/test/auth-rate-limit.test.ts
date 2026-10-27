import { describe, expect, it } from "vitest";

import {
  authRateLimitConfigFromEnv,
  createAuthRateLimiter,
  createAuthRateLimiterFromConfig,
} from "../src/auth-rate-limit.js";

describe("failure-only limiter", () => {
  it("blocks a key only after maxAttempts recorded failures", () => {
    let now = 0;
    const limiter = createAuthRateLimiter({
      maxAttempts: 2,
      windowMs: 1000,
      now: () => now,
    });

    expect(limiter.isBlocked("k")).toBe(false);
    expect(limiter.isBlocked("k")).toBe(false);
    limiter.recordFailure("k");
    expect(limiter.isBlocked("k")).toBe(false);
    limiter.recordFailure("k");
    expect(limiter.isBlocked("k")).toBe(true);
    expect(limiter.isBlocked("other")).toBe(false);
    now += 1000;
    expect(limiter.isBlocked("k")).toBe(false);
  });
});

describe("reservation, refund and reset", () => {
  it("refunds a reserved attempt and resets a key", () => {
    const limiter = createAuthRateLimiter({ maxAttempts: 2 });

    limiter.recordFailure("k");
    limiter.recordFailure("k");
    expect(limiter.isBlocked("k")).toBe(true);
    limiter.refund("k");
    expect(limiter.isBlocked("k")).toBe(false);
    limiter.recordFailure("k");
    expect(limiter.isBlocked("k")).toBe(true);
    limiter.reset("k");
    expect(limiter.isBlocked("k")).toBe(false);
    limiter.refund("never-seen");
    expect(limiter.isBlocked("never-seen")).toBe(false);
  });
});

describe("progressive lockout", () => {
  const MINUTE = 60_000;
  function build() {
    let now = 0;
    const limiter = createAuthRateLimiter({
      maxAttempts: 2,
      windowMs: 15 * MINUTE,
      now: () => now,
    });
    const fail = (key = "rut:1") => {
      limiter.recordFailure(key, { progressive: true });
      limiter.recordFailure(key, { progressive: true });
    };
    return {
      limiter,
      fail,
      advance: (ms: number) => void (now += ms),
    };
  }

  it("locks for 1 minute first, then doubles up to the window", () => {
    const { limiter, fail, advance } = build();
    const durations: number[] = [];

    for (let level = 0; level < 7; level += 1) {
      fail();
      expect(limiter.isBlocked("rut:1")).toBe(true);
      let elapsed = 0;
      while (limiter.isBlocked("rut:1")) {
        advance(1_000);
        elapsed += 1_000;
      }
      durations.push(elapsed / MINUTE);
    }

    expect(durations).toEqual([1, 2, 4, 8, 15, 15, 15]);
  });

  it("does not block before the attempts are exhausted", () => {
    const { limiter } = build();
    limiter.recordFailure("rut:1", { progressive: true });
    expect(limiter.isBlocked("rut:1")).toBe(false);
  });

  it("forgets the level after a successful login (reset)", () => {
    const { limiter, fail, advance } = build();
    fail();
    advance(MINUTE);
    fail();
    expect(limiter.isBlocked("rut:1")).toBe(true);
    advance(2 * MINUTE);
    expect(limiter.isBlocked("rut:1")).toBe(false);

    limiter.reset("rut:1");
    fail();
    advance(MINUTE);
    expect(limiter.isBlocked("rut:1")).toBe(false);
  });

  it("forgets the level after a full quiet window", () => {
    const { limiter, fail, advance } = build();
    fail();
    advance(MINUTE);
    fail();
    advance(17 * MINUTE);
    fail();
    advance(MINUTE);
    expect(limiter.isBlocked("rut:1")).toBe(false);
  });

  it("undoes the lock when the attempt that caused it is refunded", () => {
    const { limiter } = build();
    limiter.recordFailure("rut:1", { progressive: true });
    limiter.recordFailure("rut:1", { progressive: true });
    expect(limiter.isBlocked("rut:1")).toBe(true);
    limiter.refund("rut:1");
    expect(limiter.isBlocked("rut:1")).toBe(false);
  });

  it("keeps per-IP keys on the fixed window", () => {
    let now = 0;
    const limiter = createAuthRateLimiter({
      maxAttempts: 2,
      windowMs: 15 * MINUTE,
      now: () => now,
    });
    limiter.recordFailure("ip:1");
    limiter.recordFailure("ip:1");
    now += 14 * MINUTE;
    expect(limiter.isBlocked("ip:1")).toBe(true);
    now += MINUTE;
    expect(limiter.isBlocked("ip:1")).toBe(false);
  });
});

describe("memory bounds", () => {
  it("sweeps expired buckets at most once per interval", () => {
    let now = 0;
    const limiter = createAuthRateLimiter({
      maxAttempts: 5,
      windowMs: 1_000,
      purgeIntervalMs: 10_000,
      now: () => now,
    });
    for (let index = 0; index < 100; index += 1) {
      limiter.recordFailure(`ip:${index}`);
    }
    expect(limiter.size()).toBe(100);

    now = 5_000; // all expired, but the interval has not elapsed
    limiter.isBlocked("ip:0");
    expect(limiter.size()).toBe(99);
    limiter.isBlocked("ip:1");
    expect(limiter.size()).toBe(98);

    now = 10_000; // interval elapsed: one sweep drops the rest
    limiter.isBlocked("other");
    expect(limiter.size()).toBe(0);
  });

  it("never evicts a blocked key to make room for idle ones", () => {
    const limiter = createAuthRateLimiter({ maxAttempts: 1, maxEntries: 3 });
    limiter.recordFailure("blocked-a");
    limiter.recordFailure("blocked-b");
    limiter.refund("blocked-b");
    limiter.recordFailure("idle-1", { progressive: false });
    limiter.refund("idle-1");

    for (let index = 0; index < 1_000; index += 1) {
      limiter.recordFailure(`flood:${index}`);
      limiter.refund(`flood:${index}`);
    }

    expect(limiter.isBlocked("blocked-a")).toBe(true);
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });

  it("evicts the oldest blocked key only when every bucket is blocked", () => {
    const limiter = createAuthRateLimiter({ maxAttempts: 1, maxEntries: 2 });
    limiter.recordFailure("first");
    limiter.recordFailure("second");
    limiter.recordFailure("third");

    expect(limiter.size()).toBe(2);
    expect(limiter.isBlocked("first")).toBe(false);
    expect(limiter.isBlocked("second")).toBe(true);
    expect(limiter.isBlocked("third")).toBe(true);
  });
});

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

  it.each(["true", "TRUE", " true ", "True\t"])(
    "disables the limiter for %j (trimmed, case-insensitive)",
    (value) => {
      expect(
        authRateLimitConfigFromEnv({ AUTH_RATE_LIMIT_DISABLED: value }),
      ).toEqual({ disabled: true });
    },
  );

  it.each(["false", "FALSE", " false ", "", "   "])(
    "keeps the limiter enabled for %j",
    (value) => {
      expect(
        authRateLimitConfigFromEnv({ AUTH_RATE_LIMIT_DISABLED: value }),
      ).toMatchObject({ disabled: false });
    },
  );

  it.each(["yes", "1", "0", "no", "on", "truee"])(
    "fails at startup for the invalid value %j",
    (value) => {
      expect(() =>
        authRateLimitConfigFromEnv({ AUTH_RATE_LIMIT_DISABLED: value }),
      ).toThrow("AUTH_RATE_LIMIT_DISABLED must be true or false");
    },
  );

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
      limiter.recordFailure("ip:127.0.0.1");
      expect(limiter.isBlocked("ip:127.0.0.1")).toBe(false);
    }
  });
});
