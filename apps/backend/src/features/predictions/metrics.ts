import type { PrismaClient } from "../../generated/prisma/client.js";
import { logEvent } from "../../http/logging.js";

/**
 * Queue state of the automatic predictions (operational view, no PII). Only
 * the live queue (PENDING) and the recent FAILED jobs are measured: the
 * history (SUCCEEDED, SKIPPED, old FAILED) grows without bound and is never
 * scanned by the periodic gauge.
 */
export interface PredictionQueueMetrics {
  /** Jobs waiting (PENDING), due or not. */
  pendingCount: number;
  /** Age in seconds of the oldest PENDING job (by creation); null when none. */
  oldestPendingAgeSeconds: number | null;
  /** Jobs that turned FAILED during the last `windowMs`. */
  failedInWindow: number;
}

export interface PredictionMonitorConfig {
  /** Period of the queue log line. */
  intervalMs: number;
  /** FAILED jobs inside `failedWindowMs` that raise a warning. */
  failedWarnThreshold: number;
  /** Window over which FAILED jobs are counted. */
  failedWindowMs: number;
}

/**
 * PENDING count plus its oldest creation date, and the FAILED jobs of the
 * window. Both reads are index range scans whose cost follows the live queue
 * and the window, not the table size: PENDING uses
 * InvoicePrediction(status, createdAt), FAILED uses
 * InvoicePrediction(status, updatedAt). Neither reads SUCCEEDED or SKIPPED
 * rows, which accumulate forever (see the retention note in the README).
 */
export async function readPredictionQueueMetrics(
  prisma: Pick<PrismaClient, "invoicePrediction">,
  options: { now: Date; failedWindowMs: number },
): Promise<PredictionQueueMetrics> {
  const since = new Date(options.now.getTime() - options.failedWindowMs);
  const [pending, failedInWindow] = await Promise.all([
    prisma.invoicePrediction.aggregate({
      where: { status: "PENDING" },
      _count: { _all: true },
      _min: { createdAt: true },
    }),
    prisma.invoicePrediction.count({
      where: { status: "FAILED", updatedAt: { gte: since } },
    }),
  ]);
  const oldestPending = pending._min.createdAt;
  return {
    pendingCount: pending._count._all,
    oldestPendingAgeSeconds: oldestPending
      ? Math.max(
          0,
          Math.floor((options.now.getTime() - oldestPending.getTime()) / 1000),
        )
      : null,
    failedInWindow,
  };
}

/**
 * One periodic run: logs the queue state (`prediction.queue`) and, when the
 * FAILED jobs of the window reach the threshold, a warning
 * (`prediction.failed_spike`) an alert can match on.
 */
export async function reportPredictionQueue(
  prisma: Pick<PrismaClient, "invoicePrediction">,
  config: PredictionMonitorConfig,
  now: () => Date = () => new Date(),
): Promise<PredictionQueueMetrics> {
  const metrics = await readPredictionQueueMetrics(prisma, {
    now: now(),
    failedWindowMs: config.failedWindowMs,
  });
  logEvent("info", "prediction.queue", {
    feature: "predictions",
    pendingCount: metrics.pendingCount,
    failedInWindow: metrics.failedInWindow,
    ...(metrics.oldestPendingAgeSeconds === null
      ? {}
      : { oldestPendingAgeSeconds: metrics.oldestPendingAgeSeconds }),
  });
  if (metrics.failedInWindow >= config.failedWarnThreshold) {
    logEvent("warn", "prediction.failed_spike", {
      feature: "predictions",
      failedInWindow: metrics.failedInWindow,
      windowSeconds: Math.round(config.failedWindowMs / 1000),
      threshold: config.failedWarnThreshold,
    });
  }
  return metrics;
}
