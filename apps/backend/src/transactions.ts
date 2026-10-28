import { Prisma } from "./generated/prisma/client.js";
import { ApiError } from "./http/errors.js";

/** Options of every interactive transaction that runs under runSerializable. */
export const SERIALIZABLE = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
} as const;

const MAX_SERIALIZABLE_RETRIES = 3;

// Jittered pause between two attempts so conflicting transactions that failed
// together do not collide again in lockstep.
const MIN_BACKOFF_MS = 10;
const MAX_BACKOFF_MS = 50;

function backoff() {
  const delay =
    MIN_BACKOFF_MS + Math.random() * (MAX_BACKOFF_MS - MIN_BACKOFF_MS);
  return new Promise<void>((resolve) => setTimeout(resolve, delay));
}

// PostgreSQL SQLSTATEs of a lost serialization race (40001) and a deadlock
// (40P01): both are retryable by repeating the whole transaction.
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

/**
 * Prisma reports a lost race as P2034 for its own queries, but wraps the same
 * failure of a raw query (the membership row locks) as P2010 carrying the
 * driver SQLSTATE; both are conflicts.
 */
function isTransactionConflict(error: unknown) {
  const failure = error as {
    code?: unknown;
    cause?: { originalCode?: unknown };
    meta?: {
      driverAdapterError?: { cause?: { originalCode?: unknown } };
      code?: unknown;
    };
  };
  if (failure.code === "P2034") return true;
  // A serialization failure or deadlock surfaced by the driver adapter itself
  // (DriverAdapterError, no Prisma code) carries the SQLSTATE on its cause.
  const causeState = failure.cause?.originalCode;
  if (typeof causeState === "string" && RETRYABLE_SQLSTATES.has(causeState)) {
    return true;
  }
  if (failure.code !== "P2010") return false;
  const sqlState =
    failure.meta?.driverAdapterError?.cause?.originalCode ?? failure.meta?.code;
  return typeof sqlState === "string" && RETRYABLE_SQLSTATES.has(sqlState);
}

/**
 * Prisma P2028 is its interactive-transaction API error: the transaction
 * timed out (or was closed) before it finished. Nothing was committed, so the
 * client may repeat the request.
 */
function isTransactionTimeout(error: unknown) {
  return (error as { code?: unknown }).code === "P2028";
}

/** True for a Prisma unique-constraint violation (P2002). */
export function isUniqueViolation(error: unknown) {
  return (error as { code?: unknown }).code === "P2002";
}

/** Seconds a client should wait before repeating a conflicted request. */
const RETRY_AFTER_SECONDS = "1";

function retryableConflict() {
  return new ApiError(
    503,
    "RETRYABLE_CONFLICT",
    "The operation conflicted with a concurrent change; retry",
    undefined,
    { "Retry-After": RETRY_AFTER_SECONDS },
  );
}

/**
 * Retries a serializable operation a bounded number of times on conflicts,
 * pausing 10-50 ms (jittered) between attempts. When retries run out,
 * `conflictError` builds the error to throw; the default is a retryable 503
 * (RETRYABLE_CONFLICT with Retry-After). A transaction timeout (P2028) is not
 * repeated in-process: it maps straight to the same retryable 503.
 */
export async function runSerializable<T>(
  operation: () => Promise<T>,
  conflictError: () => Error = retryableConflict,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (isTransactionTimeout(error)) throw retryableConflict();
      if (!isTransactionConflict(error)) throw error;
      if (attempt === MAX_SERIALIZABLE_RETRIES - 1) throw conflictError();
      await backoff();
    }
  }

  throw conflictError();
}
