import { afterEach, describe, expect, it, vi } from "vitest";

import { createBackgroundTask } from "../../src/background-task.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("background task (CR-508)", () => {
  it("runs on every interval and never overlaps", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    let calls = 0;
    const task = createBackgroundTask({
      name: "test",
      intervalMs: 1_000,
      run: () => {
        calls += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    task.start();
    task.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
    // Three more ticks while the first run is still in flight: skipped.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(1);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    release?.();
    await task.stop();
  });

  it("logs a failure and keeps ticking", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const task = createBackgroundTask({
      name: "flaky",
      intervalMs: 500,
      run: async () => {
        calls += 1;
        throw new Error("boom with a secret");
      },
    });
    task.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls).toBe(3);
    const logged = errors.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("background_task.failed");
    expect(logged).not.toContain("secret");
    await task.stop();
  });

  it("stop waits for the run in flight and stops ticking", async () => {
    vi.useFakeTimers();
    let finished = false;
    let starts = 0;
    const task = createBackgroundTask({
      name: "slow",
      intervalMs: 100,
      run: async () => {
        starts += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        finished = true;
      },
    });
    task.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(starts).toBe(1);
    const stopped = task.stop();
    await vi.advanceTimersByTimeAsync(50);
    await stopped;
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(starts).toBe(1);
  });

  it("stop aborts the signal of the run in flight instead of waiting for it (CR-517)", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const task = createBackgroundTask({
      name: "slow-pass",
      intervalMs: 100,
      // A pass that would take an hour unless the signal fires.
      run: (signal) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3_600_000);
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
    });
    task.start();
    await vi.advanceTimersByTimeAsync(100);
    const stopped = task.stop();
    // No clock advance: stop() settles because the signal fired.
    await stopped;
    expect(aborted).toBe(true);
  });

  it("hands a fresh signal to the runs after a stop and a start", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const task = createBackgroundTask({
      name: "restart",
      intervalMs: 100,
      run: async (signal) => {
        signals.push(signal);
      },
    });
    task.start();
    await vi.advanceTimersByTimeAsync(100);
    await task.stop();
    task.start();
    await vi.advanceTimersByTimeAsync(100);
    await task.stop();
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]).not.toBe(signals[0]);
  });
});
