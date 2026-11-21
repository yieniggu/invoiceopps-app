// Error envelope used by every /api/v1 endpoint: { error: { code, message, fields? } }.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly fields?: Record<string, unknown>,
    /** Whole seconds of the `Retry-After` header, when it sent a usable one. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * A request that got no response: `fetch` rejects with a TypeError (offline,
 * DNS, connection refused, CORS) or, when it is cut short, with a
 * DOMException named TimeoutError or AbortError. Any other throw (a body that
 * does not parse, a bug) is not proof that the network failed.
 */
export function isNetworkFailure(error: unknown) {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError"))
  );
}

export function isUnauthorized(error: unknown) {
  return isApiError(error) && error.status === 401;
}

/** Builds the typed error for a non-2xx response without leaking the body. */
export async function readApiError(response: Response): Promise<ApiError> {
  let code: string | undefined;
  let message = "Request failed";
  let fields: Record<string, unknown> | undefined;
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown; fields?: unknown };
    };
    if (typeof body.error?.code === "string") code = body.error.code;
    if (typeof body.error?.message === "string") message = body.error.message;
    if (body.error?.fields && typeof body.error.fields === "object")
      fields = body.error.fields as Record<string, unknown>;
  } catch {
    // An empty or non-JSON body still carries the HTTP status.
  }
  return new ApiError(
    response.status,
    code,
    message,
    fields,
    parseRetryAfter(response.headers.get("Retry-After")),
  );
}

const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

/** `Retry-After` as whole seconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(
  header: string | null,
  now = Date.now(),
): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - now) / 1000);
  if (!Number.isFinite(seconds) || seconds < 1) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/** «30 s», «2 min», «1 h»: the wait of a rate limit, rounded up. */
export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  return `${Math.ceil(seconds / 3600)} h`;
}

/** «Espera 2 min.» for a 429 that told how long, else a generic «Espera un momento.». */
export function describeWait(error: unknown): string {
  const seconds = isApiError(error) ? error.retryAfterSeconds : undefined;
  return seconds === undefined
    ? "Espera un momento."
    : `Espera ${formatWait(seconds)}.`;
}

const MESSAGES: Record<string, string> = {
  VALIDATION_ERROR: "Revisa los datos ingresados e intenta nuevamente.",
  UNAUTHENTICATED: "Tu sesión expiró. Inicia sesión nuevamente.",
  FORBIDDEN: "No tienes permiso para realizar esta acción.",
  NOT_FOUND: "No se encontró el recurso solicitado.",
  ONBOARDING_REQUIRED:
    "Debes cambiar tu contraseña temporal antes de continuar.",
  FORBIDDEN_ORIGIN:
    "La solicitud fue rechazada por seguridad. Recarga la página e intenta nuevamente.",
  USER_NOT_FOUND: "No existe una persona registrada con ese RUT.",
  ORGANIZATION_SLUG_CONFLICT:
    "Ya existe una organización con ese identificador.",
  MEMBERSHIP_CONFLICT: "Esa persona ya pertenece a este grupo u organización.",
  LAST_ADMIN_REQUIRED:
    "No puedes quitar ni cambiar el rol del último administrador de la organización.",
  USER_CONFLICT: "Ya existe un usuario con ese RUT.",
  ORGANIZATION_MEMBERSHIP_REQUIRED:
    "La persona debe pertenecer a la organización antes de asignarla a un grupo.",
  RETRYABLE_CONFLICT:
    "El sistema está ocupado. Intenta nuevamente en unos segundos.",
};

/** Spanish text for a failed request; the server message is never shown. */
export function describeError(error: unknown, fallback: string) {
  if (
    isApiError(error) &&
    (error.status === 429 || error.code === "RATE_LIMITED")
  )
    return `Demasiados intentos. ${describeWait(error)}`;
  if (isApiError(error) && error.code && MESSAGES[error.code])
    return MESSAGES[error.code];
  if (isApiError(error)) return fallback;
  return "No fue posible conectar con el servidor. Revisa tu conexión e intenta nuevamente.";
}
