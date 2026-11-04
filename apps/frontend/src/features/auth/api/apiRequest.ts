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
  options: RequestOptions = {},
): Promise<T> {
  const response = await send(path, options);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * A read next to the server's clock at the time it answered. The instant is
 * kept beside the body, never inside it, so a DTO stays exactly what the
 * server sent and a client-only field cannot travel back in a request built
 * from cached data.
 */
export interface ServerTimed<T> {
  body: T;
  /** Epoch ms of the server's `Date` header (the local clock without it). */
  serverNow: number;
}

/**
 * Like `apiRequest`, plus the server's clock when it answered (its `Date`
 * header, which has second precision). Ages computed against it («Activo hace
 * …») compare two server instants, so a wrong clock on the viewer's device
 * does not skew them. Falls back to the local clock when the header is missing
 * or unreadable.
 */
export async function apiRequestServerTimed<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ServerTimed<T>> {
  const response = await send(path, options);
  const header = Date.parse(response.headers.get("Date") ?? "");
  return {
    body: (await response.json()) as T,
    serverNow: Number.isNaN(header) ? Date.now() : header,
  };
}

async function send(
  path: string,
  { method = "GET", body, signal, headers }: RequestOptions,
): Promise<Response> {
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
  return response;
}
