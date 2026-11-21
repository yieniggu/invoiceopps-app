import { describe, expect, it } from "vitest";

import {
  DEFAULT_PREDICTION_WORKER_CONFIG,
  predictionMonitorConfigFromEnv,
  predictionWorkerConfigFromEnv,
} from "../../src/features/predictions/config.js";
import {
  backoffDelayMs,
  MAX_PREDICT_BODY_BYTES,
  MAX_PRIOR_INVOICES,
  UNAVAILABLE_ERROR_CODES,
} from "../../src/features/predictions/worker.js";

const config = { retryBaseMs: 5_000, retryMaxMs: 15 * 60_000 };

describe("prediction retry backoff (CR-501)", () => {
  it("doubles from the base and is capped at retryMaxMs", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 40, 400].map((retries) =>
      backoffDelayMs(retries, config, () => 1),
    );
    expect(delays.slice(0, 8)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000,
    ]);
    // 5 s * 2^8 = 1280 s is above the 900 s cap, and stays there forever.
    expect(delays.slice(8)).toEqual(Array(4).fill(900_000));
  });

  it("jitters between 50% and 100% of the delay", () => {
    expect(backoffDelayMs(3, config, () => 0)).toBe(10_000);
    expect(backoffDelayMs(3, config, () => 1)).toBe(20_000);
  });

  it("covers a three-minute outage with only a handful of retries", () => {
    let elapsed = 0;
    let retries = 0;
    while (elapsed < 3 * 60_000) {
      retries += 1;
      elapsed += backoffDelayMs(retries, config, () => 1);
    }
    expect(retries).toBeLessThanOrEqual(6);
  });

  it("treats only unavailability codes as free of attempts", () => {
    for (const code of [
      "MODEL_API_UNREACHABLE",
      "MODEL_API_TIMEOUT",
      "MODEL_API_UNAVAILABLE",
      "INFERENCE_UNAVAILABLE",
      "MODEL_API_AUTH",
    ]) {
      expect(UNAVAILABLE_ERROR_CODES.has(code)).toBe(true);
    }
    for (const code of [
      "MODEL_API_ERROR",
      "DEPLOYMENT_NOT_LOADED",
      "WORKER_ERROR",
      "INVALID_INPUT",
    ]) {
      expect(UNAVAILABLE_ERROR_CODES.has(code)).toBe(false);
    }
  });
});

describe("Model API request limits", () => {
  it("keeps every prediction under the Model API limits", () => {
    // Model API: 4 MiB body, 5000 priors per invoice (20000 per batch).
    expect(MAX_PREDICT_BODY_BYTES).toBeLessThan(4 * 1024 * 1024);
    expect(MAX_PRIOR_INVOICES).toBeLessThanOrEqual(5000);
  });
});

describe("prediction worker settings (CR-501, CR-504)", () => {
  it("defaults to a 24 hour maximum job age and a 15 minute backoff cap", () => {
    expect(DEFAULT_PREDICTION_WORKER_CONFIG.maxJobAgeMs).toBe(86_400_000);
    expect(predictionWorkerConfigFromEnv({})).toMatchObject({
      maxJobAgeMs: 86_400_000,
      retryMaxMs: 900_000,
    });
  });

  it("reads the new variables and refuses malformed or inconsistent ones", () => {
    expect(
      predictionWorkerConfigFromEnv({
        PREDICTION_MAX_JOB_AGE_MS: "3600000",
        PREDICTION_RETRY_MAX_MS: "60000",
      }),
    ).toMatchObject({ maxJobAgeMs: 3_600_000, retryMaxMs: 60_000 });
    expect(() =>
      predictionWorkerConfigFromEnv({ PREDICTION_MAX_JOB_AGE_MS: "0" }),
    ).toThrow(/PREDICTION_MAX_JOB_AGE_MS/);
    expect(() =>
      predictionWorkerConfigFromEnv({
        PREDICTION_RETRY_BASE_MS: "10000",
        PREDICTION_RETRY_MAX_MS: "5000",
      }),
    ).toThrow(/PREDICTION_RETRY_MAX_MS/);
  });

  it("reads the queue gauge settings", () => {
    expect(predictionMonitorConfigFromEnv({})).toEqual({
      intervalMs: 60_000,
      failedWarnThreshold: 10,
      failedWindowMs: 900_000,
    });
    expect(() =>
      predictionMonitorConfigFromEnv({ PREDICTION_FAILED_WARN_THRESHOLD: "x" }),
    ).toThrow(/PREDICTION_FAILED_WARN_THRESHOLD/);
  });
});
