// Exit-code decisions of the E2E backend launcher (e2e-backend.mjs), pure so
// they can be unit tested.

/** 128 + signal number of the signals the launcher forwards. */
export const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * Exit code of the launcher once the server exited. A signal the launcher
 * received wins (128+N) even when the server exited 0 on a graceful stop;
 * otherwise the server's own code, 1 when it died by a signal, 0 if neither.
 */
export function launcherExitCode({ stopping, code, signal }) {
  if (stopping) return stopping;
  return code ?? (signal ? 1 : 0);
}

/**
 * Grace period for a child to exit after a forwarded stop signal (CR-445).
 * Shorter than Playwright's `gracefulShutdown` timeout (10 s in
 * apps/e2e/playwright.config.ts), so under Playwright the launcher kills a hung
 * server before Playwright kills the whole group (CR-450).
 */
export const FORCE_KILL_MS = 8_000;

/**
 * After a stop signal was forwarded to `child`, SIGKILLs it if it has not
 * exited within `graceMs`, so a hung server can never keep the launcher (and
 * Playwright's teardown) waiting forever. The timer never keeps the launcher
 * alive by itself and is cleared once the child exits. Returns the timer.
 */
export function forceKillAfter(
  child,
  {
    graceMs = FORCE_KILL_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  const timer = setTimer(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, graceMs);
  timer?.unref?.();
  child.once("exit", () => clearTimer(timer));
  return timer;
}

/**
 * A child that could not be spawned (or whose kill failed) emits "error" and
 * may never emit "exit": log a stage line and leave with 128+N when stopping,
 * 1 otherwise, instead of crashing on an unhandled "error" event (CR-445).
 */
export function exitOnChildError(child, { label, stage, getStopping, exit }) {
  child.on("error", (error) => {
    // Only the error code: a message can carry absolute paths (CR-453).
    stage(`${label} error (${error?.code ?? "unknown"})`);
    exit(getStopping() || 1);
  });
}
