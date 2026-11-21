import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readPredictionQueueMetrics,
  reportPredictionQueue,
} from "../../src/features/predictions/metrics.js";

afterEach(() => vi.restoreAllMocks());

const NOW = new Date("2026-11-20T12:00:00.000Z");

function fakePrisma(options: {
  pending: number;
  oldestPending: Date | null;
  failedRecent: number;
}) {
  const calls: { aggregate?: unknown; count?: unknown; groupBy: number } = {
    groupBy: 0,
  };
  const prisma = {
    invoicePrediction: {
      aggregate: async (args: unknown) => {
        calls.aggregate = args;
        return {
          _count: { _all: options.pending },
          _min: { createdAt: options.oldestPending },
        };
      },
      count: async (args: unknown) => {
        calls.count = args;
        return options.failedRecent;
      },
      groupBy: async () => {
        calls.groupBy += 1;
        return [];
      },
    },
  };
  return { prisma: prisma as never, calls };
}

describe("prediction queue metrics (CR-504, CR-516)", () => {
  it("returns the PENDING count, its oldest age and the recent FAILED", async () => {
    const { prisma } = fakePrisma({
      pending: 4,
      oldestPending: new Date(NOW.getTime() - 90_500),
      failedRecent: 2,
    });
    const metrics = await readPredictionQueueMetrics(prisma, {
      now: NOW,
      failedWindowMs: 15 * 60_000,
    });
    expect(metrics).toEqual({
      pendingCount: 4,
      oldestPendingAgeSeconds: 90,
      failedInWindow: 2,
    });
  });

  it("only reads PENDING rows and the FAILED window, never the whole table", async () => {
    const { prisma, calls } = fakePrisma({
      pending: 0,
      oldestPending: null,
      failedRecent: 0,
    });
    await readPredictionQueueMetrics(prisma, {
      now: NOW,
      failedWindowMs: 15 * 60_000,
    });
    // PENDING only: (status, createdAt) serves the count and the minimum.
    expect(calls.aggregate).toEqual({
      where: { status: "PENDING" },
      _count: { _all: true },
      _min: { createdAt: true },
    });
    // FAILED bounded to the window: (status, updatedAt) range.
    expect(calls.count).toEqual({
      where: {
        status: "FAILED",
        updatedAt: { gte: new Date(NOW.getTime() - 15 * 60_000) },
      },
    });
    // No grouped read over every status.
    expect(calls.groupBy).toBe(0);
  });

  it("has no oldest age when nothing is PENDING", async () => {
    const { prisma } = fakePrisma({
      pending: 0,
      oldestPending: null,
      failedRecent: 0,
    });
    const metrics = await readPredictionQueueMetrics(prisma, {
      now: NOW,
      failedWindowMs: 1_000,
    });
    expect(metrics).toEqual({
      pendingCount: 0,
      oldestPendingAgeSeconds: null,
      failedInWindow: 0,
    });
  });

  it("logs the gauge and warns only when FAILED reaches the threshold", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = {
      intervalMs: 60_000,
      failedWarnThreshold: 3,
      failedWindowMs: 600_000,
    };
    await reportPredictionQueue(
      fakePrisma({ pending: 0, oldestPending: null, failedRecent: 2 }).prisma,
      config,
      () => NOW,
    );
    expect(String(info.mock.calls[0]?.[0])).toContain(
      '"event":"prediction.queue"',
    );
    expect(warn).not.toHaveBeenCalled();

    await reportPredictionQueue(
      fakePrisma({ pending: 0, oldestPending: null, failedRecent: 3 }).prisma,
      config,
      () => NOW,
    );
    const line = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      level: "warn",
      event: "prediction.failed_spike",
      failedInWindow: 3,
      windowSeconds: 600,
      threshold: 3,
    });
  });
});
