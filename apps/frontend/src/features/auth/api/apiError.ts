// Error envelope used by every /api/v1 endpoint: { error: { code, message, fields? } }.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly fields?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
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
  return new ApiError(response.status, code, message, fields);
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
  if (isApiError(error) && error.code && MESSAGES[error.code])
    return MESSAGES[error.code];
  if (isApiError(error)) return fallback;
  return "No fue posible conectar con el servidor. Revisa tu conexión e intenta nuevamente.";
}
