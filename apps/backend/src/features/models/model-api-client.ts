import type { ServiceEndpoint } from "./config.js";
import {
  isRecord,
  requestJson,
  ServiceUnreachableError,
  type ServiceFailureKind,
} from "./http-json.js";

export interface GateReason {
  code: string;
  message: string;
  detail: Record<string, unknown>;
}

export interface GateMetrics {
  auc: number | null;
  dummyAuc: number | null;
  lift: number | null;
  minAuc: number | null;
  minLift: number | null;
  validationRows: number | null;
}

/** What the Model API says about one gate run. */
export interface GateReport {
  passed: boolean;
  reasons: GateReason[];
  metrics: GateMetrics | null;
  featureSchemaVersion: string | null;
  runId: string | null;
}

export type DeployOutcome =
  | { kind: "loaded"; report: GateReport }
  | { kind: "rejected"; report: GateReport };

export interface ModelRef {
  workspace: string;
  registeredModel: string;
  version: string;
}

export interface ModelApiState {
  /** Ids loaded and serving. */
  loaded: ReadonlySet<string>;
  /** Ids the Model API quarantined after repeated inference crashes. */
  quarantined: ReadonlySet<string>;
}

/**
 * The Model API is down, misbehaving or refused the service credential.
 * `reason` says how far the call got: `connection` = nothing answered (the
 * request never ran), `timeout` = no answer in time (it may still be
 * running), `response` = it answered with an error or an unusable body.
 */
export class ModelApiUnavailableError extends Error {
  constructor(readonly reason: ServiceFailureKind = "response") {
    super("The model service is unavailable");
  }
}

/** The Model API has no room for another loaded deployment (409). */
export class ModelApiCapacityError extends Error {
  constructor() {
    super("The model service cannot load more deployments");
  }
}

/** Body of POST /deployments/{id}/predict (the Model API computes features). */
export interface PredictRequest {
  invoice: {
    supplierName: string;
    amountPesos: number;
    /** YYYY-MM-DD */
    issuedOn: string;
    /** YYYY-MM-DD */
    dueOn: string;
    /** ISO 8601 instant */
    createdAt: string;
    businessStatus?: string;
  };
  priorInvoices: Array<{
    supplierName: string;
    amountPesos: number;
    createdAt: string;
    businessStatus: string;
  }>;
}

export interface Prediction {
  modelVersion: string;
  runId: string | null;
  featureSchemaVersion: string | null;
  probability: number;
}

export type PredictOutcome =
  | { kind: "ok"; prediction: Prediction }
  /** 404 DEPLOYMENT_NOT_LOADED: the Model API forgot it (restart). */
  | { kind: "not_loaded" }
  /** The Model API answered with an error; `retryable` says if trying again can help. */
  | { kind: "error"; retryable: boolean; code: string };

export interface ModelApiClient {
  /**
   * PUT /deployments/{id}. The Model API re-runs the full gate and loads the
   * model only if it passes, so one call both checks and activates (a single
   * hidden-set evaluation per deploy). Idempotent for the same reference.
   */
  deploy(
    deploymentId: string,
    ref: ModelRef,
    options?: CallOptions,
  ): Promise<DeployOutcome>;
  /** DELETE /deployments/{id}; unloading something not loaded is fine. */
  unload(deploymentId: string, options?: CallOptions): Promise<void>;
  /**
   * POST /deployments/{id}/predict. Connection failures and timeouts throw
   * ModelApiUnavailableError (reason "aborted" when `options.signal` fired);
   * answers come back as a PredictOutcome.
   */
  predict(
    deploymentId: string,
    request: PredictRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PredictOutcome>;
  /** GET /deployments: what is loaded and what is quarantined right now. */
  state(options?: CallOptions): Promise<ModelApiState>;
}

/** `signal` aborts the call (graceful shutdown): it throws ModelApiUnavailableError("aborted"). */
export interface CallOptions {
  signal?: AbortSignal;
}

const DEPLOY_TIMEOUT_MS = 120_000;
const QUICK_TIMEOUT_MS = 10_000;
const PREDICT_TIMEOUT_MS = 15_000;

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metricsOf(value: unknown): GateMetrics | null {
  if (!isRecord(value)) return null;
  return {
    auc: numberOrNull(value.auc),
    dummyAuc: numberOrNull(value.dummyAuc),
    lift: numberOrNull(value.lift),
    minAuc: numberOrNull(value.minAuc),
    minLift: numberOrNull(value.minLift),
    validationRows: numberOrNull(value.validationRows),
  };
}

const MAX_REASONS = 20;
const MAX_REASON_TEXT = 300;
const MAX_DETAIL_BYTES = 2_000;

function reasonOf(value: unknown): GateReason | null {
  if (!isRecord(value) || typeof value.code !== "string") return null;
  const detail = isRecord(value.detail) ? value.detail : {};
  return {
    code: value.code.slice(0, 64),
    message:
      typeof value.message === "string"
        ? value.message.slice(0, MAX_REASON_TEXT)
        : "",
    // Detail is small structured data (metrics, type names); oversize is dropped.
    detail: JSON.stringify(detail).length <= MAX_DETAIL_BYTES ? detail : {},
  };
}

function reportOf(body: Record<string, unknown>): GateReport {
  const reasons = Array.isArray(body.reasons)
    ? body.reasons
        .slice(0, MAX_REASONS)
        .map(reasonOf)
        .filter((reason): reason is GateReason => reason !== null)
    : [];
  const model = isRecord(body.model) ? body.model : {};
  return {
    passed: body.passed === true,
    reasons,
    metrics: metricsOf(body.metrics),
    featureSchemaVersion:
      typeof body.featureSchemaVersion === "string"
        ? body.featureSchemaVersion.slice(0, 64)
        : null,
    runId: typeof model.runId === "string" ? model.runId.slice(0, 64) : null,
  };
}

function idsOf(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) return ids;
  for (const item of value) {
    if (isRecord(item) && typeof item.deploymentId === "string") {
      ids.add(item.deploymentId);
    }
  }
  return ids;
}

export interface ModelApiClientOptions {
  /** Test seam: shortens the (long) gate-and-load timeout. */
  deployTimeoutMs?: number;
}

export function createModelApiClient(
  endpoint: ServiceEndpoint,
  options: ModelApiClientOptions = {},
): ModelApiClient {
  const headers = { Authorization: `Bearer ${endpoint.token}` };
  const base = endpoint.url;

  async function call(
    method: "GET" | "PUT" | "DELETE" | "POST",
    path: string,
    timeoutMs: number,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    try {
      return await requestJson("model-api", `${base}${path}`, {
        method,
        headers,
        body,
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof ServiceUnreachableError) {
        throw new ModelApiUnavailableError(error.kind);
      }
      throw error;
    }
  }

  return {
    async deploy(deploymentId, ref, callOptions = {}) {
      const { status, body } = await call(
        "PUT",
        `/deployments/${encodeURIComponent(deploymentId)}`,
        options.deployTimeoutMs ?? DEPLOY_TIMEOUT_MS,
        ref,
        callOptions.signal,
      );
      const detail = isRecord(body) && isRecord(body.detail) ? body.detail : {};
      if (status === 200 && isRecord(body)) {
        const model = { runId: body.runId };
        return {
          kind: "loaded",
          report: {
            ...reportOf({
              passed: true,
              reasons: [],
              metrics: body.metrics,
              model,
            }),
            // The load summary does not repeat the schema version.
            featureSchemaVersion: null,
          },
        };
      }
      if (status === 422 && detail.code === "GATE_FAILED") {
        return { kind: "rejected", report: reportOf(detail) };
      }
      if (status === 409 && detail.code === "CAPACITY_EXCEEDED") {
        throw new ModelApiCapacityError();
      }
      // 401/403 (wrong service token), 502 MLFLOW_UNAVAILABLE, 503
      // GATE_UNAVAILABLE / INFERENCE_UNAVAILABLE, 5xx or an unexpected shape.
      throw new ModelApiUnavailableError();
    },

    async predict(deploymentId, request, options = {}) {
      const { status, body } = await call(
        "POST",
        `/deployments/${encodeURIComponent(deploymentId)}/predict`,
        PREDICT_TIMEOUT_MS,
        request,
        options.signal,
      );
      const detail = isRecord(body) && isRecord(body.detail) ? body.detail : {};
      const code =
        typeof detail.code === "string" ? detail.code.slice(0, 64) : null;
      if (
        status === 200 &&
        isRecord(body) &&
        typeof body.probability === "number" &&
        Number.isFinite(body.probability) &&
        body.probability >= 0 &&
        body.probability <= 1 &&
        typeof body.modelVersion === "string"
      ) {
        return {
          kind: "ok",
          prediction: {
            modelVersion: body.modelVersion.slice(0, 20),
            runId:
              typeof body.runId === "string" ? body.runId.slice(0, 64) : null,
            featureSchemaVersion:
              typeof body.featureSchemaVersion === "string"
                ? body.featureSchemaVersion.slice(0, 64)
                : null,
            probability: body.probability,
          },
        };
      }
      if (status === 404 && code === "DEPLOYMENT_NOT_LOADED") {
        return { kind: "not_loaded" };
      }
      // A request the Model API rejects as invalid (400/422, or 413 for a body
      // over its 4 MiB limit) will not get better: terminal INVALID_INPUT.
      if (status === 400 || status === 413 || status === 422) {
        return { kind: "error", retryable: false, code: "INVALID_INPUT" };
      }
      if (status === 401 || status === 403) {
        return { kind: "error", retryable: true, code: "MODEL_API_AUTH" };
      }
      // 502/503/504 say "not available right now" (the service or its
      // upstream is down; 503 BUSY = its download gate is full): the worker
      // waits without consuming an attempt. Any other failure answer keeps
      // MODEL_API_ERROR and counts.
      return {
        kind: "error",
        retryable: true,
        code:
          code === "INFERENCE_UNAVAILABLE"
            ? code
            : code === "BUSY" ||
                status === 502 ||
                status === 503 ||
                status === 504
              ? "MODEL_API_UNAVAILABLE"
              : "MODEL_API_ERROR",
      };
    },

    async unload(deploymentId, callOptions = {}) {
      const { status } = await call(
        "DELETE",
        `/deployments/${encodeURIComponent(deploymentId)}`,
        QUICK_TIMEOUT_MS,
        undefined,
        callOptions.signal,
      );
      if (status !== 200) throw new ModelApiUnavailableError();
    },

    async state(callOptions = {}) {
      const { status, body } = await call(
        "GET",
        "/deployments",
        QUICK_TIMEOUT_MS,
        undefined,
        callOptions.signal,
      );
      if (status !== 200 || !isRecord(body))
        throw new ModelApiUnavailableError();
      return {
        loaded: idsOf(body.deployments),
        quarantined: idsOf(body.quarantined),
      };
    },
  };
}
