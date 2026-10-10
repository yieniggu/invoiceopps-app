function serializeCanonicalValue(
  value: unknown,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Canonical evidence requires safe integers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error("Unsupported canonical evidence value");
  }
  if (ancestors.has(value)) {
    throw new Error("Cyclic canonical evidence value");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Reflect.ownKeys(value).some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" ||
              !/^(0|[1-9]\d*)$/.test(key) ||
              Number(key) >= value.length),
        )
      ) {
        throw new Error("Unsupported canonical evidence array property");
      }
      return `[${Array.from({ length: value.length }, (_, index) => {
        if (!Object.hasOwn(value, index)) {
          throw new Error("Sparse canonical evidence array");
        }
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error("Unsupported canonical evidence array property");
        }
        return serializeCanonicalValue(descriptor.value, ancestors);
      }).join(",")}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Canonical evidence requires plain objects");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new Error("Canonical evidence requires string keys");
    }
    return `{${(keys as string[])
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error("Unsupported canonical evidence property");
        }
        return `${JSON.stringify(key)}:${serializeCanonicalValue(descriptor.value, ancestors)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeEvidenceValue(value: unknown): Uint8Array {
  return Buffer.from(serializeCanonicalValue(value, new Set()), "utf8");
}

export {
  buildEvidenceBatchV2,
  hashEvidenceV2Bytes,
  hashEvidenceV2Pair,
  verifyEvidenceProofV2,
} from "./evidence-merkle.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const CANONICAL_VERSION = "invoice-evidence-canonical-v2";
const EVIDENCE_VERSION = "invoice-evidence-v2";
const EVIDENCE_KEYS = [
  "correlation_id",
  "decision",
  "decision_event_id",
  "evaluated_at",
  "evidence_version",
  "invoice_record_id",
  "manual_review_threshold",
  "mode",
  "model_id",
  "model_run_id",
  "model_version",
  "organization_id",
  "owner_id",
  "owner_type",
  "policy_probability",
  "policy_probability_source",
  "policy_version",
  "recommendation",
  "rule_version",
] as const;

function dataObject(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("Invalid Evidence V2 object");
  }
  return value as Record<string, unknown>;
}

function ownValue(object: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    throw new Error(`Missing Evidence V2 field: ${key}`);
  }
  return descriptor.value;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error("Invalid Evidence V2 UUID");
  }
  return value;
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Invalid Evidence V2 string");
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return value === null ? null : nonempty(value);
}

function timestamp(value: unknown): string {
  const text = value instanceof Date ? value.toISOString() : value;
  if (
    typeof text !== "string" ||
    !TIMESTAMP.test(text) ||
    Number.isNaN(Date.parse(text)) ||
    new Date(text).toISOString() !== text
  ) {
    throw new Error("Invalid Evidence V2 timestamp");
  }
  return text;
}

function decimal(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 128) {
    throw new Error("Invalid Evidence V2 decimal");
  }
  const match = DECIMAL.exec(value);
  if (!match) throw new Error("Invalid Evidence V2 decimal");
  const [, whole, fraction = "", exponentText = "0"] = match;
  const exponent = Number(exponentText);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 32) {
    throw new Error("Invalid Evidence V2 decimal exponent");
  }
  const digits = whole + fraction;
  const point = whole.length + exponent;
  const expanded =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${"0".repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [integral, fractional = ""] = expanded.split(".");
  const left = integral.replace(/^0+(?=\d)/, "");
  const right = fractional.replace(/0+$/, "");
  if (left !== "0" && left !== "1") {
    throw new Error("Evidence V2 decimal is outside [0, 1]");
  }
  if (left === "1" && right) {
    throw new Error("Evidence V2 decimal is outside [0, 1]");
  }
  return right ? `${left}.${right}` : left;
}

function validatePayload(value: unknown): Record<string, unknown> {
  const payload = dataObject(value);
  if (
    Reflect.ownKeys(payload).length !== EVIDENCE_KEYS.length ||
    EVIDENCE_KEYS.some((key) => !Object.hasOwn(payload, key))
  ) {
    throw new Error("Invalid Evidence V2 fields");
  }
  if (ownValue(payload, "evidence_version") !== EVIDENCE_VERSION) {
    throw new Error("Invalid Evidence V2 version");
  }
  for (const key of [
    "decision_event_id",
    "invoice_record_id",
    "organization_id",
    "owner_id",
    "correlation_id",
  ]) {
    uuid(ownValue(payload, key));
  }
  timestamp(ownValue(payload, "evaluated_at"));
  const decision = ownValue(payload, "decision");
  if (decision !== "AUTO_PROCESS" && decision !== "MANUAL_REVIEW") {
    throw new Error("Invalid Evidence V2 decision");
  }
  const mode = ownValue(payload, "mode");
  if (mode !== "RULE_V1" && mode !== "PROBABILITY_POLICY") {
    throw new Error("Invalid Evidence V2 mode");
  }
  const owner = ownValue(payload, "owner_type");
  if (owner !== "user" && owner !== "group") {
    throw new Error("Invalid Evidence V2 owner type");
  }
  nonempty(ownValue(payload, "rule_version"));
  const policy = optionalString(ownValue(payload, "policy_version"));
  const rawThreshold = ownValue(payload, "manual_review_threshold");
  const rawProbability = ownValue(payload, "policy_probability");
  const threshold = decimal(rawThreshold);
  const probability = decimal(rawProbability);
  if (threshold !== rawThreshold || probability !== rawProbability) {
    throw new Error("Noncanonical Evidence V2 decimal");
  }
  const source = ownValue(payload, "policy_probability_source");
  const modelId = optionalString(ownValue(payload, "model_id"));
  const modelVersion = optionalString(ownValue(payload, "model_version"));
  const runId = optionalString(ownValue(payload, "model_run_id"));
  const recommendation = ownValue(payload, "recommendation");
  if (
    recommendation !== null &&
    recommendation !== "AUTO_PROCESS" &&
    recommendation !== "MANUAL_REVIEW"
  ) {
    throw new Error("Invalid Evidence V2 recommendation");
  }
  if (mode === "RULE_V1") {
    if (
      policy !== null ||
      threshold !== null ||
      probability !== null ||
      source !== null ||
      modelId !== null ||
      modelVersion !== null ||
      runId !== null ||
      recommendation !== null
    ) {
      throw new Error("Invalid Evidence V2 Rule v1 snapshot");
    }
  } else if (policy === null || threshold === null) {
    throw new Error("Incomplete Evidence V2 policy snapshot");
  } else if (source === "MODEL_API") {
    if (
      probability === null ||
      modelId === null ||
      modelVersion === null ||
      runId === null ||
      recommendation !== decision
    ) {
      throw new Error("Incomplete Evidence V2 model snapshot");
    }
  } else if (source === "MODEL_API_FALLBACK") {
    if (
      probability !== null ||
      modelId !== null ||
      modelVersion !== null ||
      runId !== null ||
      recommendation !== "MANUAL_REVIEW" ||
      decision !== "MANUAL_REVIEW"
    ) {
      throw new Error("Invalid Evidence V2 fallback snapshot");
    }
  } else if (source === "LOCAL_DEMONSTRATION") {
    if (
      probability === null ||
      modelId !== null ||
      modelVersion !== null ||
      runId !== null ||
      recommendation !== null
    ) {
      throw new Error("Invalid Evidence V2 demonstration snapshot");
    }
  } else {
    throw new Error("Invalid Evidence V2 probability source");
  }
  return payload;
}

export function buildEvidenceV2Payload(
  input: unknown,
): Record<string, unknown> {
  const request = dataObject(input);
  const event = dataObject(ownValue(request, "event"));
  const context = dataObject(ownValue(request, "context"));
  const ownerType = ownValue(context, "ownerType");
  const payload: Record<string, unknown> = {
    evidence_version: EVIDENCE_VERSION,
    decision_event_id: ownValue(event, "id"),
    invoice_record_id: ownValue(event, "invoiceId"),
    organization_id: ownValue(context, "organizationId"),
    owner_type:
      ownerType === "USER"
        ? "user"
        : ownerType === "GROUP"
          ? "group"
          : ownerType,
    owner_id: ownValue(context, "ownerId"),
    correlation_id: ownValue(event, "correlationId"),
    evaluated_at: timestamp(ownValue(event, "createdAt")),
    decision: ownValue(event, "decision"),
    mode: ownValue(event, "mode"),
    rule_version: ownValue(event, "ruleVersion"),
    policy_version: ownValue(event, "policyVersion"),
    manual_review_threshold: decimal(ownValue(event, "manualReviewThreshold")),
    policy_probability: decimal(ownValue(event, "policyProbability")),
    policy_probability_source: ownValue(event, "policyProbabilitySource"),
    model_id: ownValue(event, "modelId"),
    model_version: ownValue(event, "modelVersion"),
    model_run_id: ownValue(event, "modelRunId"),
    recommendation: ownValue(event, "recommendation"),
  };
  return validatePayload(payload);
}

export function canonicalizeEvidenceV2(payload: unknown): Uint8Array {
  return canonicalizeEvidenceValue({
    canonical_version: CANONICAL_VERSION,
    evidence: validatePayload(payload),
  });
}
