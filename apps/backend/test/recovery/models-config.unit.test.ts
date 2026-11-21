import { describe, expect, it } from "vitest";

import { modelsConfigFromEnv } from "../../src/features/models/config.js";

// Fixed, randomly generated looking value (secrets must pass the randomness check).
const SECRET = "7c1e9a04d2b85f63a9e07b4c1d6f2385e0a49c7b";

describe("MLOPS-05 startup configuration", () => {
  it("is off with safe defaults when nothing is set", () => {
    expect(modelsConfigFromEnv({})).toEqual({
      modelApi: undefined,
      gateway: undefined,
      mlflowPublicUrl: undefined,
      maxActiveDeployments: 3,
      maxDeployChecksPerHour: 10,
    });
    expect(
      modelsConfigFromEnv({ MODEL_API_URL: "", MODEL_API_SERVICE_TOKEN: " " }),
    ).toMatchObject({ modelApi: undefined });
  });

  it("accepts a complete configuration and trims the trailing slash", () => {
    const config = modelsConfigFromEnv({
      MODEL_API_URL: "http://model-api:8000/",
      MODEL_API_SERVICE_TOKEN: SECRET,
      MLFLOW_GATEWAY_INTERNAL_URL: "http://gateway:8080",
      GATEWAY_SERVICE_READ_TOKEN: SECRET,
      MLFLOW_PUBLIC_URL: "https://mlflow.example.com/",
      MODEL_DEPLOYMENT_MAX_ACTIVE_PER_SCOPE: "5",
      MODEL_DEPLOY_CHECK_MAX_PER_HOUR: "20",
    });
    expect(config.modelApi).toEqual({
      url: "http://model-api:8000",
      token: SECRET,
    });
    expect(config.gateway?.url).toBe("http://gateway:8080");
    expect(config.mlflowPublicUrl).toBe("https://mlflow.example.com");
    expect(config.maxActiveDeployments).toBe(5);
    expect(config.maxDeployChecksPerHour).toBe(20);
  });

  it.each([
    ["a URL without its secret", { MODEL_API_URL: "http://m:8000" }],
    ["a secret without its URL", { GATEWAY_SERVICE_READ_TOKEN: SECRET }],
    [
      "a short secret",
      { MODEL_API_URL: "http://m:8000", MODEL_API_SERVICE_TOKEN: "short" },
    ],
    [
      "a secret with whitespace",
      {
        MODEL_API_URL: "http://m:8000",
        MODEL_API_SERVICE_TOKEN: `${SECRET} x`,
      },
    ],
    [
      "a non-http URL",
      { MODEL_API_URL: "ftp://m", MODEL_API_SERVICE_TOKEN: SECRET },
    ],
    [
      "a URL with credentials",
      { MODEL_API_URL: "http://u:p@m", MODEL_API_SERVICE_TOKEN: SECRET },
    ],
    ["a bad public URL", { MLFLOW_PUBLIC_URL: "not a url" }],
    ["a zero cap", { MODEL_DEPLOYMENT_MAX_ACTIVE_PER_SCOPE: "0" }],
    ["a fractional rate limit", { MODEL_DEPLOY_CHECK_MAX_PER_HOUR: "1.5" }],
  ])("refuses to start with %s, never echoing a secret", (_label, env) => {
    let message = "";
    try {
      modelsConfigFromEnv(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("short");
  });
});
