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
