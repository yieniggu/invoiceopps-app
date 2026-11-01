import { readApiError } from "./apiError";
import { protectedFetch } from "./protectedFetch";

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Extra request headers (for example `Idempotency-Key`). */
  headers?: Record<string, string>;
}

/**
 * JSON transport for org-scoped endpoints. Non-2xx answers throw ApiError;
 * 204 resolves undefined. Every read and write goes through protectedFetch so
 * ONBOARDING_REQUIRED is noticed in one place.
 */
export async function apiRequest<T>(
  path: string,
  { method = "GET", body, signal, headers }: RequestOptions = {},
): Promise<T> {
  const response = await protectedFetch(path, {
    method,
    credentials: "same-origin",
    signal,
    ...(body === undefined && headers === undefined
      ? {}
      : {
          headers: {
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            ...headers,
          },
        }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await readApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
