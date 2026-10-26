export interface AuthRateLimiter {
  allow(origin: string): boolean;
}

interface RateLimitBucket {
  attempts: number;
  windowStartedAt: number;
}

export interface AuthRateLimiterOptions {
  maxAttempts?: number;
  maxEntries?: number;
  now?: () => number;
  windowMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

export function createAuthRateLimiter({
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = Date.now,
  windowMs = DEFAULT_WINDOW_MS,
}: AuthRateLimiterOptions = {}): AuthRateLimiter {
  const buckets = new Map<string, RateLimitBucket>();

  return {
    allow(origin) {
      const currentTime = now();

      for (const [key, bucket] of buckets) {
        if (currentTime - bucket.windowStartedAt >= windowMs) {
          buckets.delete(key);
        }
      }

      const bucket = buckets.get(origin);

      if (bucket) {
        if (bucket.attempts >= maxAttempts) {
          return false;
        }

        bucket.attempts += 1;
        return true;
      }

      if (buckets.size >= maxEntries) {
        const oldestOrigin = buckets.keys().next().value;

        if (oldestOrigin !== undefined) {
          buckets.delete(oldestOrigin);
        }
      }

      buckets.set(origin, { attempts: 1, windowStartedAt: currentTime });
      return true;
    },
  };
}

export const disabledAuthRateLimiter: AuthRateLimiter = {
  allow: () => true,
};

export interface AuthRateLimitEnvironment {
  AUTH_RATE_LIMIT_DISABLED?: string;
  AUTH_RATE_LIMIT_MAX_ATTEMPTS?: string;
  AUTH_RATE_LIMIT_WINDOW_MS?: string;
  NODE_ENV?: string;
}

export type AuthRateLimitConfig =
  | { disabled: true }
  | { disabled: false; maxAttempts: number; windowMs: number };

function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  if (!/^\d+$/.test(value.trim()) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

/** Pure parser for the auth rate-limit flags. Throws on invalid configuration. */
export function authRateLimitConfigFromEnv(
  env: AuthRateLimitEnvironment,
): AuthRateLimitConfig {
  const disabled =
    env.AUTH_RATE_LIMIT_DISABLED?.trim().toLowerCase() === "true";

  if (disabled && env.NODE_ENV === "production") {
    throw new Error("AUTH_RATE_LIMIT_DISABLED is not allowed in production");
  }

  const maxAttempts = positiveInteger(
    "AUTH_RATE_LIMIT_MAX_ATTEMPTS",
    env.AUTH_RATE_LIMIT_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
  );
  const windowMs = positiveInteger(
    "AUTH_RATE_LIMIT_WINDOW_MS",
    env.AUTH_RATE_LIMIT_WINDOW_MS,
    DEFAULT_WINDOW_MS,
  );

  return disabled
    ? { disabled: true }
    : { disabled: false, maxAttempts, windowMs };
}

export function createAuthRateLimiterFromConfig(
  config: AuthRateLimitConfig,
): AuthRateLimiter {
  return config.disabled
    ? disabledAuthRateLimiter
    : createAuthRateLimiter({
        maxAttempts: config.maxAttempts,
        windowMs: config.windowMs,
      });
}
