import { positiveInteger } from "../models/config.js";
import type { PredictionMonitorConfig } from "./metrics.js";

/**
 * Settings of the automatic-prediction worker (MLOPS-06). All have safe
 * defaults; a malformed value is a configuration mistake and the process
 * refuses to start.
 */
export interface PredictionWorkerConfig {
  /** Pause between polls when the last poll found nothing (or less than a batch). */
  pollIntervalMs: number;
  /** Predict attempts per job before it is marked FAILED. */
  maxAttempts: number;
  /** Jobs processed at the same time by one worker. */
  concurrency: number;
  /** Jobs claimed per poll. */
  batchSize: number;
  /** First retry delay; doubles with every retry (with jitter). */
  retryBaseMs: number;
  /** Ceiling of the retry delay (also of the unavailability backoff). */
  retryMaxMs: number;
  /**
   * A job older than this (counted from its creation) is not retried any more
   * and turns FAILED (JOB_EXPIRED). Retries caused by an unavailable Model API
   * consume no attempt, so this is the only bound of an outage.
   */
  maxJobAgeMs: number;
  /**
   * A claimed job is invisible to other workers for this long. It must exceed
   * the slowest legitimate attempt (a Model API reload runs up to 2 minutes),
   * so a job is only picked up again after its worker died.
   */
  leaseMs: number;
}

export interface PredictionEnv {
  PREDICTION_WORKER_POLL_MS?: string;
  PREDICTION_MAX_ATTEMPTS?: string;
  PREDICTION_CONCURRENCY?: string;
  PREDICTION_BATCH_SIZE?: string;
  PREDICTION_RETRY_BASE_MS?: string;
  PREDICTION_RETRY_MAX_MS?: string;
  PREDICTION_MAX_JOB_AGE_MS?: string;
  PREDICTION_WORKER_DISABLED?: string;
}

export interface PredictionMonitorEnv {
  PREDICTION_METRICS_INTERVAL_MS?: string;
  PREDICTION_FAILED_WARN_THRESHOLD?: string;
  PREDICTION_FAILED_WINDOW_MS?: string;
}

export const DEFAULT_PREDICTION_WORKER_CONFIG: PredictionWorkerConfig = {
  pollIntervalMs: 2_000,
  maxAttempts: 5,
  concurrency: 4,
  batchSize: 10,
  retryBaseMs: 5_000,
  retryMaxMs: 15 * 60 * 1_000,
  maxJobAgeMs: 24 * 60 * 60 * 1_000,
  leaseMs: 5 * 60 * 1_000,
};

export function predictionWorkerConfigFromEnv(
  env: PredictionEnv,
): PredictionWorkerConfig {
  const defaults = DEFAULT_PREDICTION_WORKER_CONFIG;
  const config = {
    ...defaults,
    pollIntervalMs: positiveInteger(
      "PREDICTION_WORKER_POLL_MS",
      env.PREDICTION_WORKER_POLL_MS,
      defaults.pollIntervalMs,
      600_000,
    ),
    maxAttempts: positiveInteger(
      "PREDICTION_MAX_ATTEMPTS",
      env.PREDICTION_MAX_ATTEMPTS,
      defaults.maxAttempts,
      50,
    ),
    concurrency: positiveInteger(
      "PREDICTION_CONCURRENCY",
      env.PREDICTION_CONCURRENCY,
      defaults.concurrency,
      32,
    ),
    batchSize: positiveInteger(
      "PREDICTION_BATCH_SIZE",
      env.PREDICTION_BATCH_SIZE,
      defaults.batchSize,
      100,
    ),
    retryBaseMs: positiveInteger(
      "PREDICTION_RETRY_BASE_MS",
      env.PREDICTION_RETRY_BASE_MS,
      defaults.retryBaseMs,
      3_600_000,
    ),
    retryMaxMs: positiveInteger(
      "PREDICTION_RETRY_MAX_MS",
      env.PREDICTION_RETRY_MAX_MS,
      defaults.retryMaxMs,
      24 * 60 * 60 * 1_000,
    ),
    maxJobAgeMs: positiveInteger(
      "PREDICTION_MAX_JOB_AGE_MS",
      env.PREDICTION_MAX_JOB_AGE_MS,
      defaults.maxJobAgeMs,
      30 * 24 * 60 * 60 * 1_000,
    ),
  };
  if (config.retryMaxMs < config.retryBaseMs) {
    throw new Error(
      "PREDICTION_RETRY_MAX_MS must not be smaller than PREDICTION_RETRY_BASE_MS",
    );
  }
  return config;
}

export const DEFAULT_PREDICTION_MONITOR_CONFIG: PredictionMonitorConfig = {
  intervalMs: 60_000,
  failedWarnThreshold: 10,
  failedWindowMs: 15 * 60 * 1_000,
};

/** Settings of the periodic queue gauge (CR-504); a malformed value refuses to start. */
export function predictionMonitorConfigFromEnv(
  env: PredictionMonitorEnv,
): PredictionMonitorConfig {
  const defaults = DEFAULT_PREDICTION_MONITOR_CONFIG;
  return {
    intervalMs: positiveInteger(
      "PREDICTION_METRICS_INTERVAL_MS",
      env.PREDICTION_METRICS_INTERVAL_MS,
      defaults.intervalMs,
      3_600_000,
    ),
    failedWarnThreshold: positiveInteger(
      "PREDICTION_FAILED_WARN_THRESHOLD",
      env.PREDICTION_FAILED_WARN_THRESHOLD,
      defaults.failedWarnThreshold,
      1_000_000,
    ),
    failedWindowMs: positiveInteger(
      "PREDICTION_FAILED_WINDOW_MS",
      env.PREDICTION_FAILED_WINDOW_MS,
      defaults.failedWindowMs,
      7 * 24 * 60 * 60 * 1_000,
    ),
  };
}

/** The worker runs unless explicitly disabled (and the Model API is configured). */
export function predictionWorkerEnabled(env: PredictionEnv): boolean {
  return env.PREDICTION_WORKER_DISABLED?.trim().toLowerCase() !== "true";
}
