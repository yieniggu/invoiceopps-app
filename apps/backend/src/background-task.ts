import { logEvent } from "./http/logging.js";

/**
 * A periodic in-process task. Runs never overlap (a slow run delays the next
 * tick instead of stacking), a failure is logged and never stops the loop, and
 * `stop()` aborts the signal handed to the run in flight, then waits for it.
 * A run that honors the signal ends quickly, so shutdown does not wait for a
 * slow pass (CR-517). The timer is unref'd, so an idle task never keeps the
 * process alive.
 */
export interface BackgroundTask {
  /** Starts ticking (idempotent). The first run happens after one interval. */
  start(): void;
  /** Stops ticking, aborts the run in flight (its signal) and waits for it. */
  stop(): Promise<void>;
  /** One run now; skipped (resolves false) while another run is in flight. */
  runOnce(): Promise<boolean>;
}

export function createBackgroundTask(options: {
  /** Fixed label used in logs. */
  name: string;
  intervalMs: number;
  /** `signal` aborts when stop() is called: pass it to slow calls. */
  run: (signal: AbortSignal) => Promise<unknown>;
}): BackgroundTask {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopping = new AbortController();

  async function runOnce() {
    if (running) return false;
    running = (async () => {
      try {
        await options.run(stopping.signal);
      } catch (error) {
        logEvent("error", "background_task.failed", {
          feature: options.name,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    })();
    try {
      await running;
    } finally {
      running = undefined;
    }
    return true;
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      if (stopping.signal.aborted) stopping = new AbortController();
      timer = setInterval(() => void runOnce(), options.intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      stopping.abort();
      await running;
    },
  };
}
