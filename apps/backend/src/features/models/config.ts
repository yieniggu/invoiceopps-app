import { validatedServiceSecret } from "../../service-secret.js";

/** Active deployments one scope (group, or organization) may hold at once. */
export const DEFAULT_MAX_ACTIVE_DEPLOYMENTS = 3;
/** Gate runs (deploy attempts) one scope may start per hour. */
export const DEFAULT_MAX_DEPLOY_CHECKS_PER_HOUR = 10;

export interface ServiceEndpoint {
  /** Base URL without a trailing slash. */
  url: string;
  token: string;
}

export interface ModelsConfig {
  /** Absent until MODEL_API_URL and MODEL_API_SERVICE_TOKEN are both set. */
  modelApi?: ServiceEndpoint;
  /** Absent until MLFLOW_GATEWAY_INTERNAL_URL and GATEWAY_SERVICE_READ_TOKEN are both set. */
  gateway?: ServiceEndpoint;
  /** Browser-facing MLflow URL, used only to build links. */
  mlflowPublicUrl?: string;
  maxActiveDeployments: number;
  maxDeployChecksPerHour: number;
}

export interface ModelsEnv {
  MODEL_API_URL?: string;
  MODEL_API_SERVICE_TOKEN?: string;
  MLFLOW_GATEWAY_INTERNAL_URL?: string;
  GATEWAY_SERVICE_READ_TOKEN?: string;
  MLFLOW_PUBLIC_URL?: string;
  MODEL_DEPLOYMENT_MAX_ACTIVE_PER_SCOPE?: string;
  MODEL_DEPLOY_CHECK_MAX_PER_HOUR?: string;
}

function blank(value: string | undefined) {
  return value === undefined || value.trim() === "";
}

function httpUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be an http(s) URL`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `${name} must be an http(s) URL without credentials, query or fragment`,
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

/** A service is configured only when both its URL and its secret are set. */
function endpoint(
  urlName: string,
  tokenName: string,
  url: string | undefined,
  token: string | undefined,
): ServiceEndpoint | undefined {
  const hasUrl = !blank(url);
  const hasToken = !blank(token);
  if (!hasUrl && !hasToken) return undefined;
  if (hasUrl !== hasToken) {
    throw new Error(`${urlName} and ${tokenName} must be set together`);
  }
  return {
    url: httpUrl(urlName, url as string),
    // Same rule as INTERNAL_INTROSPECTION_SECRET; the message never echoes the value.
    token: validatedServiceSecret(tokenName, token as string),
  };
}

export function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  max: number,
) {
  if (blank(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

/**
 * Startup validation of the MLOPS-05 settings. Everything unset keeps the
 * feature off (its endpoints answer 503 and nothing else is affected); a
 * half-set or malformed value is a configuration mistake and the process
 * refuses to start. Messages never contain secret values.
 */
export function modelsConfigFromEnv(env: ModelsEnv): ModelsConfig {
  return {
    modelApi: endpoint(
      "MODEL_API_URL",
      "MODEL_API_SERVICE_TOKEN",
      env.MODEL_API_URL,
      env.MODEL_API_SERVICE_TOKEN,
    ),
    gateway: endpoint(
      "MLFLOW_GATEWAY_INTERNAL_URL",
      "GATEWAY_SERVICE_READ_TOKEN",
      env.MLFLOW_GATEWAY_INTERNAL_URL,
      env.GATEWAY_SERVICE_READ_TOKEN,
    ),
    mlflowPublicUrl: blank(env.MLFLOW_PUBLIC_URL)
      ? undefined
      : httpUrl("MLFLOW_PUBLIC_URL", env.MLFLOW_PUBLIC_URL as string),
    maxActiveDeployments: positiveInteger(
      "MODEL_DEPLOYMENT_MAX_ACTIVE_PER_SCOPE",
      env.MODEL_DEPLOYMENT_MAX_ACTIVE_PER_SCOPE,
      DEFAULT_MAX_ACTIVE_DEPLOYMENTS,
      50,
    ),
    maxDeployChecksPerHour: positiveInteger(
      "MODEL_DEPLOY_CHECK_MAX_PER_HOUR",
      env.MODEL_DEPLOY_CHECK_MAX_PER_HOUR,
      DEFAULT_MAX_DEPLOY_CHECKS_PER_HOUR,
      1000,
    ),
  };
}

/** Defaults used by tests and by an app built without server.ts. */
export function defaultModelsConfig(): ModelsConfig {
  return {
    maxActiveDeployments: DEFAULT_MAX_ACTIVE_DEPLOYMENTS,
    maxDeployChecksPerHour: DEFAULT_MAX_DEPLOY_CHECKS_PER_HOUR,
  };
}
