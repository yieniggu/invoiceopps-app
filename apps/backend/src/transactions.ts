import { ApiError } from "./http/errors.js";

const MAX_SERIALIZABLE_RETRIES = 3;

function isTransactionConflict(error: unknown) {
  return (error as { code?: unknown }).code === "P2034";
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
 * Retries a serializable operation a bounded number of times on conflicts.
 * When retries run out, `conflictError` builds the error to throw; the default
 * is a retryable 503 (RETRYABLE_CONFLICT with Retry-After).
 */
export async function runSerializable<T>(
  operation: () => Promise<T>,
  conflictError: () => Error = retryableConflict,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransactionConflict(error)) throw error;
      if (attempt === MAX_SERIALIZABLE_RETRIES - 1) throw conflictError();
    }
  }

  throw conflictError();
}
