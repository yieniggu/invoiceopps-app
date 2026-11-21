import { describeWait, isApiError } from "../auth/api/apiError";
import type { Deployment, DeploymentStatus, GateReason } from "./types";

const decimal = new Intl.NumberFormat("es-CL", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** AUC and lift as the screens show them (two decimals, es-CL). */
export const formatScore = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value)
    ? decimal.format(value)
    : "—";

const list = (value: unknown): string =>
  Array.isArray(value) && value.length > 0
    ? value.map((item) => String(item).slice(0, 80)).join(", ")
    : "—";

type Describer = (detail: Record<string, unknown>) => string;

/**
 * Spanish text of every reason code the Model API can give. The messages the
 * service sends are English diagnostics for operators; students read these.
 */
const REASONS: Record<string, Describer> = {
  INVALID_REFERENCE: () =>
    "El nombre o la versión del modelo no es válido: se necesita una versión numérica fija, no un alias.",
  MODEL_VERSION_NOT_FOUND: () =>
    "No se encontró esa versión del modelo registrado en este contexto.",
  ARTIFACT_SOURCE_NOT_ALLOWED: () =>
    "El origen de los archivos del modelo no está permitido. Registra el modelo con log_model desde un run de este contexto.",
  ARTIFACT_LAYOUT_INVALID: () =>
    "Los archivos del modelo no tienen la estructura esperada (MLmodel y model.skops).",
  ARTIFACT_TOO_LARGE: () => "El modelo supera el tamaño máximo permitido.",
  PICKLE_FORMAT_NOT_ALLOWED: () =>
    "El modelo usa pickle o joblib. Solo se aceptan modelos guardados en formato skops.",
  UNSUPPORTED_FLAVOR: () =>
    "El tipo de modelo no es compatible. Usa scikit-learn guardado con skops.",
  UNTRUSTED_TYPE: ({ types }) =>
    `El modelo contiene tipos no permitidos: ${list(types)}.`,
  SKOPS_ARCHIVE_INVALID: () => "El archivo skops del modelo no es válido.",
  MODEL_LOAD_FAILED: () => "No fue posible cargar el modelo.",
  MODEL_STRUCTURE_INVALID: () =>
    "La estructura interna del modelo no es válida.",
  MODEL_CHECK_CRASHED: () =>
    "La verificación del modelo falló de forma inesperada.",
  MODEL_CHECK_TIMEOUT: () =>
    "La verificación del modelo superó el tiempo máximo.",
  SIGNATURE_MISSING: () =>
    "El modelo no declara la firma (signature) de sus columnas de entrada.",
  SIGNATURE_MISMATCH: ({ expected, found }) =>
    `Las columnas del modelo no coinciden con el contrato invoice-features-v2 (esperadas: ${list(expected)}; encontradas: ${list(found)}).`,
  NO_PREDICT_PROBA: () =>
    "El modelo no entrega probabilidades (predict_proba).",
  INVALID_CLASSES: () =>
    "El modelo debe ser un clasificador binario con clases 0 y 1.",
  INFERENCE_FAILED: () =>
    "El modelo falló al predecir sobre los datos de validación.",
  AUC_BELOW_MIN: ({ auc, minAuc }) =>
    `AUC ${formatScore(auc)} en validación oficial, mínimo ${formatScore(minAuc)}`,
  AUC_LIFT_BELOW_MIN: ({ auc, dummyAuc, minLift }) =>
    `AUC ${formatScore(auc)} no supera al modelo base (${formatScore(dummyAuc)}) por al menos ${formatScore(minLift)}`,
  CHECK_INTERRUPTED: () =>
    "La verificación no terminó. Vuelve a desplegar el modelo.",
};

export function describeReason(reason: GateReason): string {
  const describer = REASONS[reason.code];
  return describer
    ? describer(reason.detail)
    : `El modelo no cumplió una condición de validación (código ${reason.code.slice(0, 40)}).`;
}

export const STATUS_LABEL: Record<DeploymentStatus, string> = {
  CHECKING: "Verificando",
  ACTIVE: "Activo",
  INACTIVE: "Inactivo",
  FAILED: "Rechazado",
  QUARANTINED: "En cuarentena",
};

export const STATUS_TONE: Record<DeploymentStatus, string> = {
  CHECKING: "is-pending",
  ACTIVE: "is-approved",
  INACTIVE: "is-neutral",
  FAILED: "is-rejected",
  QUARANTINED: "is-rejected",
};

/** One line with the official-validation numbers of a gate run, if any. */
export function describeMetrics(gate: Deployment["gate"]): string {
  const metrics = gate?.metrics;
  if (!metrics) return "";
  return `AUC ${formatScore(metrics.auc)} (mínimo ${formatScore(metrics.minAuc)}), modelo base ${formatScore(metrics.dummyAuc)}`;
}

/** Statuses that hold a slot of the scope's cap (and the model's version). */
export const HOLDS_SLOT: ReadonlySet<DeploymentStatus> = new Set([
  "CHECKING",
  "ACTIVE",
]);
export const IS_LIVE: ReadonlySet<DeploymentStatus> = new Set([
  "CHECKING",
  "ACTIVE",
  "QUARANTINED",
]);

/**
 * Short Spanish text of a failed Models request (the server message is never
 * shown). A gateway timeout (504, or Cloudflare's 524) or any non-JSON answer of the proxy (no
 * error code) reads as «sin respuesta»: the outcome is unknown and the list
 * says what really happened.
 */
export function describeModelsFailure(
  error: unknown,
  fallback: string,
): string {
  if (!isApiError(error)) return fallback;
  const failure = error;
  // A busy database also answers 503: tell it apart from the service outage.
  if (failure.code === "RETRYABLE_CONFLICT")
    return "Sistema ocupado. Intenta en unos segundos.";
  // The 409 has two origins (the scope's cap, or the model service having no
  // room) and the backend sends no `fields` to tell them apart, so the text
  // claims neither; the refreshed list shows the scope's own cap when it is.
  if (failure.code === "DEPLOYMENT_LIMIT") return "No hay cupo ahora.";
  if (failure.code === "RATE_LIMITED" || failure.status === 429)
    return `Demasiadas verificaciones. ${describeWait(failure)}`;
  if (failure.code === "CONFLICT") return "El despliegue cambió.";
  if (failure.code === "SERVICE_UNAVAILABLE" || failure.status === 503)
    return "Servicio de modelos no disponible.";
  if (failure.status === 403) return "Sin permiso para desplegar.";
  if (failure.status === 404) return "Sección o despliegue no disponible.";
  // 524 is Cloudflare's «origin did not answer in time» (~100 s), the edge
  // twin of nginx's 504: same unknown outcome, same refresh of the list.
  if (
    failure.status === 504 ||
    failure.status === 524 ||
    (failure.status >= 500 && !failure.code)
  )
    return "Sin respuesta del servicio.";
  return fallback;
}

/**
 * Why a registered version cannot be deployed right now. `loading` has no
 * text on purpose: the skeleton of the list already says it.
 */
export type DeployBlock =
  { kind: "loading" } | { kind: "live" } | { kind: "cap"; max: number };

/** Short text of a block, or undefined when there is nothing to say. */
export function describeDeployBlock(block: DeployBlock): string | undefined {
  if (block.kind === "live") return "Ya desplegada";
  if (block.kind === "cap") return `Máximo de ${block.max} activos`;
  return undefined;
}
