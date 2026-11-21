// Small fetch helper shared by the two internal service clients. It never
// follows redirects (the service token must only ever reach the configured
// host), bounds every call with a timeout and never throws the response body
// or the URL into an error message.

/** Largest response body read from an internal service (configurable cap). */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * `connection`: nothing answered (refused, DNS, redirect). `timeout`: the call
 * ran out of time, so the service may still be working on it. `response`: it
 * answered with a body over the size cap.
 */
export type ServiceFailureKind =
  | "connection"
  | "timeout"
  | "response"
  /** The caller's AbortSignal fired (graceful shutdown); not a service fault. */
  | "aborted";

export class ServiceUnreachableError extends Error {
  constructor(
    readonly service: "model-api" | "mlflow-gateway",
    readonly kind: ServiceFailureKind = "connection",
  ) {
    super(`${service} is unreachable`);
  }
}

/** Reads at most `maxBytes` of the body; null when it is larger. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  if (!response.body) return "";
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

export async function requestJson(
  service: "model-api" | "mlflow-gateway",
  url: string,
  init: {
    method: "GET" | "PUT" | "DELETE" | "POST";
    headers: Record<string, string>;
    body?: unknown;
    timeoutMs: number;
    maxResponseBytes?: number;
    /** Aborts the call (in flight or while reading the body) with kind "aborted". */
    signal?: AbortSignal;
  },
): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        Accept: "application/json",
        ...(init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([AbortSignal.timeout(init.timeoutMs), init.signal])
        : AbortSignal.timeout(init.timeoutMs),
    });
  } catch (error) {
    if (init.signal?.aborted) {
      throw new ServiceUnreachableError(service, "aborted");
    }
    throw new ServiceUnreachableError(
      service,
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "connection",
    );
  }
  let body: unknown = null;
  try {
    const text = await readCapped(
      response,
      init.maxResponseBytes ?? MAX_RESPONSE_BYTES,
    );
    if (text === null) throw new ServiceUnreachableError(service, "response");
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof ServiceUnreachableError) throw error;
    if (init.signal?.aborted) {
      throw new ServiceUnreachableError(service, "aborted");
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new ServiceUnreachableError(service, "timeout");
    }
    // A body that is not JSON (or a read that failed) is "no body".
    body = null;
  }
  return { status: response.status, body };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
