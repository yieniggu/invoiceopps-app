import { isApiError, isNetworkFailure } from "../auth/api/apiError";

/**
 * What a failed create tells about the attempt, which decides how its key is
 * handled:
 * - uncertain: the invoice may exist (no answer, 503, any other 5xx). The same
 *   key and body can be sent again and never duplicate.
 * - burned: the key can not be reused for this request (409 with a different
 *   body, 410 after the invoice was deleted). Only a NEW operation is valid.
 * - rejected: the API refused the request; nothing was created and the key
 *   is spent, so the next attempt starts fresh.
 */
export type FailureKind = "uncertain" | "burned" | "rejected";

export interface CreateFailure {
  kind: FailureKind;
  message: string;
  /** Field the message belongs to, when the person can fix it there. */
  field?: "businessId";
  /** HTTP status, or empty when no response arrived (automation contract). */
  status: string;
  /**
   * API error code; `NETWORK` without a response, `UNKNOWN` for any other
   * throw, empty when the API sent none.
   */
  code: string;
}

const RETRY_HINT =
  "Puedes reintentar: se enviará la misma solicitud y no se duplicará.";

export function describeCreateFailure(error: unknown): CreateFailure {
  // Whatever the cause, a send was attempted: the invoice may exist, so the
  // same key stays retryable. Only a TypeError, a timeout or an abort is known to be «no response».
  if (!isApiError(error) && !isNetworkFailure(error))
    return {
      kind: "uncertain",
      message: `Ocurrió un error inesperado y no sabemos si la factura se creó. ${RETRY_HINT}`,
      status: "",
      code: "UNKNOWN",
    };
  if (!isApiError(error))
    return {
      kind: "uncertain",
      message: `No recibimos respuesta del servidor, así que no sabemos si la factura se creó. ${RETRY_HINT}`,
      status: "",
      code: "NETWORK",
    };
  const { status, code } = error;
  const reply = { status: String(status), code: code ?? "" };
  if (status === 409 && code === "IDEMPOTENCY_CONFLICT")
    return {
      kind: "burned",
      message:
        "Este envío ya se había usado con datos distintos, por eso no se creó la factura. Confirma que quieres crearla como una operación nueva.",
      ...reply,
    };
  if (status === 410)
    return {
      kind: "burned",
      message:
        "La factura que creó este envío fue eliminada después. Confirma que quieres crearla de nuevo como una operación nueva.",
      ...reply,
    };
  if (status === 409)
    return {
      kind: "rejected",
      field: "businessId",
      message:
        "Ya existe una factura con ese número en esta organización, incluso si fue eliminada. Usa otro número.",
      ...reply,
    };
  if (status === 400)
    return {
      kind: "rejected",
      message:
        "Algún dato de la factura no es válido. Revisa los campos e intenta nuevamente.",
      ...reply,
    };
  if (status === 403)
    return {
      kind: "rejected",
      message:
        "No tienes permiso para crear facturas en este alcance. Estamos actualizando tus permisos.",
      ...reply,
    };
  if (status === 404)
    return {
      kind: "rejected",
      message:
        "No encontramos la organización o el grupo elegido. Es posible que ya no exista o que no tengas acceso a él.",
      ...reply,
    };
  if (status === 503)
    return {
      kind: "uncertain",
      message: `El sistema está ocupado y no pudimos confirmar si la factura se creó. Espera unos segundos. ${RETRY_HINT}`,
      ...reply,
    };
  if (status >= 500)
    return {
      kind: "uncertain",
      message: `Ocurrió un error inesperado y no sabemos si la factura se creó. ${RETRY_HINT}`,
      ...reply,
    };
  return {
    kind: "rejected",
    message:
      "No fue posible crear la factura. Revisa los datos e intenta nuevamente.",
    ...reply,
  };
}
