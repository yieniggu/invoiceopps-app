/** Path of the gateway callback, appended to MLFLOW_PUBLIC_URL. */
export const MLFLOW_CALLBACK_PATH = "/_gateway/callback";

/**
 * Startup validation of the MLflow handoff settings. `MLFLOW_PUBLIC_URL` must
 * be a bare origin (no path, query or fragment: the callback is that origin
 * plus a fixed path, so there is no trailing-path ambiguity); in production it
 * must be https. Unset keeps the handoff off (the authorize endpoint answers
 * 503). The message never echoes more than the variable name.
 */
export function mlflowCallbackUrlFromEnv(env: {
  MLFLOW_PUBLIC_URL?: string;
  NODE_ENV?: string;
}): string | undefined {
  const raw = env.MLFLOW_PUBLIC_URL?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("MLFLOW_PUBLIC_URL must be an absolute http(s) URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/"
  ) {
    throw new Error(
      "MLFLOW_PUBLIC_URL must be an origin without credentials, path, query or fragment, e.g. https://mlflow.example.com",
    );
  }
  if (env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error("MLFLOW_PUBLIC_URL must use https in production");
  }
  return `${parsed.origin}${MLFLOW_CALLBACK_PATH}`;
}
