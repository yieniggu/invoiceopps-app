export interface RecordFailureOptions {
  /**
   * Progressive lockout: reaching `maxAttempts` locks the key for a short
   * period that doubles with every new lock (up to the window) instead of a
   * fixed window. Only the first call that creates the bucket decides.
   */
  progressive?: boolean;
}

/**
 * Failure-only limiter. `isBlocked` never consumes budget; `recordFailure`
 * does and is synchronous, so a caller that checks and records before its
 * first `await` reserves the attempt atomically (concurrent requests cannot
 * all pass the check). `refund` returns a reserved attempt that did not end
 * in a credential failure; `reset` forgets a key after a successful login.
 * Callers combine several keys (client IP, normalized account).
 */
export interface AuthRateLimiter {
  isBlocked(key: string): boolean;
  recordFailure(key: string, options?: RecordFailureOptions): void;
  refund(key: string): void;
  reset(key: string): void;
}

interface RateLimitBucket {
  attempts: number;
  windowStartedAt: number;
  progressive: boolean;
  /** Progressive buckets only: end of the current lock (0 = never locked). */
  lockedUntil: number;
  lockLevel: number;
}

export interface AuthRateLimiterOptions {
  maxAttempts?: number;
  maxEntries?: number;
  now?: () => number;
  windowMs?: number;
  /** Minimum time between full sweeps of expired buckets. */
  purgeIntervalMs?: number;
  /** Duration of the first progressive lock; it doubles up to `windowMs`. */
  firstLockMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_PURGE_INTERVAL_MS = 60 * 1000;
const DEFAULT_FIRST_LOCK_MS = 60 * 1000;

export function createAuthRateLimiter({
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = Date.now,
  windowMs = DEFAULT_WINDOW_MS,
  purgeIntervalMs = DEFAULT_PURGE_INTERVAL_MS,
  firstLockMs = DEFAULT_FIRST_LOCK_MS,
}: AuthRateLimiterOptions = {}): AuthRateLimiter & { size(): number } {
  // Map iteration order is insertion order, so the oldest bucket comes first.
  const buckets = new Map<string, RateLimitBucket>();
  let lastPurgeAt = now();

  function isLocked(bucket: RateLimitBucket, currentTime: number) {
    return bucket.progressive
      ? bucket.lockedUntil > currentTime
      : bucket.attempts >= maxAttempts;
  }

  function isExpired(bucket: RateLimitBucket, currentTime: number) {
    return (
      currentTime - bucket.windowStartedAt >= windowMs &&
      !(bucket.progressive && bucket.lockedUntil > currentTime)
    );
  }

  // Returns the live bucket, dropping it (and resetting a finished lock cycle)
  // lazily so correctness never depends on the periodic sweep.
  function liveBucket(key: string, currentTime: number) {
    const bucket = buckets.get(key);
    if (!bucket) return undefined;
    if (isExpired(bucket, currentTime)) {
      buckets.delete(key);
      return undefined;
    }
    if (
      bucket.progressive &&
      bucket.lockedUntil !== 0 &&
      bucket.lockedUntil <= currentTime &&
      bucket.attempts >= maxAttempts
    ) {
      // The lock ended: a new cycle of attempts starts, the level is kept.
      bucket.attempts = 0;
    }
    return bucket;
  }

  // O(n) sweep, at most once per interval: it only bounds memory.
  function purgeExpired(currentTime: number) {
    if (currentTime - lastPurgeAt < purgeIntervalMs) return;
    lastPurgeAt = currentTime;
    for (const [key, bucket] of buckets) {
      if (isExpired(bucket, currentTime)) buckets.delete(key);
    }
  }

  // Makes room for one bucket. Idle buckets go first (oldest first) so a flood
  // of one-off keys can never push a blocked key out. Only when every bucket
  // is currently blocked is the oldest blocked one evicted: the map is bounded
  // and that is the only way to stay bounded.
  function makeRoom(currentTime: number) {
    if (buckets.size < maxEntries) return;
    let oldestBlocked: string | undefined;
    for (const [key, bucket] of buckets) {
      if (isExpired(bucket, currentTime) || !isLocked(bucket, currentTime)) {
        buckets.delete(key);
        return;
      }
      oldestBlocked ??= key;
    }
    if (oldestBlocked !== undefined) buckets.delete(oldestBlocked);
  }

  return {
    isBlocked(key) {
      const currentTime = now();
      purgeExpired(currentTime);
      const bucket = liveBucket(key, currentTime);
      return bucket !== undefined && isLocked(bucket, currentTime);
    },
    recordFailure(key, { progressive = false } = {}) {
      const currentTime = now();
      purgeExpired(currentTime);
      let bucket = liveBucket(key, currentTime);

      if (!bucket) {
        makeRoom(currentTime);
        bucket = {
          attempts: 0,
          windowStartedAt: currentTime,
          progressive,
          lockedUntil: 0,
          lockLevel: 0,
        };
        buckets.set(key, bucket);
      }

      bucket.attempts += 1;
      if (
        bucket.progressive &&
        bucket.attempts >= maxAttempts &&
        bucket.lockedUntil <= currentTime
      ) {
        bucket.lockLevel += 1;
        bucket.lockedUntil =
          currentTime +
          Math.min(windowMs, firstLockMs * 2 ** (bucket.lockLevel - 1));
        // The level is remembered for one window after the latest lock ends.
        bucket.windowStartedAt = bucket.lockedUntil;
      }
    },
    refund(key) {
      const currentTime = now();
      const bucket = liveBucket(key, currentTime);
      if (!bucket || bucket.attempts === 0) return;
      bucket.attempts -= 1;
      if (
        bucket.progressive &&
        bucket.attempts < maxAttempts &&
        bucket.lockedUntil > currentTime
      ) {
        // The refunded attempt was the one that triggered the lock.
        bucket.lockedUntil = 0;
        bucket.lockLevel = Math.max(0, bucket.lockLevel - 1);
      }
    },
    reset(key) {
      buckets.delete(key);
    },
    size: () => buckets.size,
  };
}

export const disabledAuthRateLimiter: AuthRateLimiter = {
  isBlocked: () => false,
  recordFailure: () => {},
  refund: () => {},
  reset: () => {},
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
  const flag = (env.AUTH_RATE_LIMIT_DISABLED ?? "").trim().toLowerCase();
  if (flag !== "" && flag !== "true" && flag !== "false") {
    throw new Error("AUTH_RATE_LIMIT_DISABLED must be true or false");
  }
  const disabled = flag === "true";

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
