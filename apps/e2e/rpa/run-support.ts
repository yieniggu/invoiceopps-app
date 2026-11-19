import { writeFileSync } from "node:fs";

import { InputError } from "./args.ts";
import { writeAtomically } from "./atomic.ts";
import type { RowOutcome } from "./excel.ts";

/** Pure and injectable parts of the CLI (`run.ts`): exit codes and persistence. */

export type StopSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

/** The signals the CLI owns (Playwright's own handlers are disabled). */
export const STOP_SIGNALS: readonly StopSignal[] = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
];

const SIGNAL_EXIT: Record<StopSignal, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

/**
 * 0 finished; 1 the batch aborted or crashed, or no result could be written as
 * a workbook; 129 / 130 / 143 a SIGHUP / SIGINT / SIGTERM was received (128 +
 * signal number). A received signal wins whatever the batch state was, even
 * when every row had already finished: whoever sent it asked the process to
 * stop and must see that. (2, an input error, is decided before the browser
 * opens.)
 */
export function exitCodeFor(state: {
  abort?: { kind: string } | undefined;
  signal?: StopSignal | undefined;
  writeFailed?: boolean;
}): number {
  if (state.signal) return SIGNAL_EXIT[state.signal];
  if (state.abort || state.writeFailed) return 1;
  return 0;
}

/**
 * The final exit code of the process, decided once everything settled:
 * `result` is what `main` returned, `error` what it threw (`result` undefined).
 * Precedence: a received signal (129 / 130 / 143) over an InputError (2) over
 * any other crash (1) over the batch result (CR-433).
 */
export function finalExitCode(params: {
  signal: StopSignal | undefined;
  result: number | undefined;
  error?: unknown;
}): number {
  if (params.signal) return SIGNAL_EXIT[params.signal];
  if (params.result === undefined) {
    return params.error instanceof InputError ? 2 : 1;
  }
  return params.result;
}

/** Where the outcomes go when the output workbook can not be written. */
export const resultsJsonPath = (output: string) => `${output}.results.json`;

export type Persisted =
  { kind: "workbook" } | { kind: "json"; path: string } | { kind: "stderr" };

/**
 * Writes the output workbook; when that fails, keeps the outcomes anyway as
 * `<output>.results.json`, and as a last resort on stderr. A finished batch
 * must never lose its results (invoices were created for them).
 */
export async function persistOutcomes(params: {
  output: string;
  outcomes: readonly RowOutcome[];
  writeWorkbook: (path: string) => Promise<void>;
  /** Fills the temp file of the JSON fallback (injectable for tests). */
  writeJson?: (tempPath: string, json: string) => void;
  stderr: (line: string) => void;
}): Promise<Persisted> {
  const { output, outcomes, writeWorkbook, stderr } = params;
  const writeJson = params.writeJson ?? writeFileSync;
  try {
    await writeWorkbook(output);
    return { kind: "workbook" };
  } catch (error) {
    stderr(`Could not write ${output}: ${(error as Error).message}`);
  }
  const json = `${JSON.stringify(outcomes, null, 2)}\n`;
  const path = resultsJsonPath(output);
  try {
    await writeAtomically(path, (temp) => writeJson(temp, json));
    stderr(`The outcomes were saved to ${path}`);
    return { kind: "json", path };
  } catch (error) {
    stderr(
      `Could not write ${path}: ${(error as Error).message}. Outcomes follow:\n${json}`,
    );
    return { kind: "stderr" };
  }
}

/**
 * Options of `chromium.launch` for the CLI. Playwright's own SIGINT / SIGTERM /
 * SIGHUP handlers would close the browsers and `exit(130)` behind this
 * process's back, racing the write of the output: this CLI owns the shutdown
 * (CR-408), so the three flags must always be `false`.
 */
export function launchOptions(params: { headed: boolean }) {
  return {
    headless: !params.headed,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  } as const;
}

const DEFAULT_FORCE_QUIT_MS = 10_000;

/**
 * Signal bookkeeping of the CLI, with its side effects injected. The first
 * signal asks the batch to stop (`abort`); a second one quits, but never in the
 * middle of an atomic write (`beginWrite` / the returned `endWrite`): it waits
 * for the write to finish (it is short) and then exits with 128+N of the first signal, so neither a
 * `.tmp-<pid>` file nor a missing output is left behind (CR-430). The handlers
 * stay installed until the process exits (CR-429): a signal after the batch is
 * done only records the exit code instead of getting the default action.
 */
export function createSignalState(deps: {
  abort: () => void;
  exit: (code: number) => void;
  cleanup: () => void;
  stderr: (line: string) => void;
  /** Cap of the wait for a write in progress after a second signal; default 10 s. */
  forceQuitMs?: number;
  /** Runs `fn` after `ms` without keeping the process alive (injectable). */
  startTimer?: (fn: () => void, ms: number) => void;
}) {
  const forceQuitMs = deps.forceQuitMs ?? DEFAULT_FORCE_QUIT_MS;
  const startTimer =
    deps.startTimer ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms).unref();
    });
  let quitting = false;
  let first: StopSignal | undefined;
  let writing = 0;
  let pendingExit: number | undefined;
  const quit = (code: number) => {
    if (quitting) return;
    quitting = true;
    // A cleanup that throws (EBUSY / EPERM) must never skip the exit: the
    // process has to leave with 128+N, not an uncaught exception (CR-441).
    try {
      deps.cleanup();
    } catch (error) {
      deps.stderr(`Cleanup failed: ${(error as Error).message}`);
    } finally {
      deps.exit(code);
    }
  };
  return {
    get signal(): StopSignal | undefined {
      return first;
    },
    handle(received: StopSignal): void {
      if (first) {
        if (pendingExit !== undefined) {
          deps.stderr("Third signal: exiting now.");
          quit(pendingExit);
          return;
        }
        if (writing > 0) {
          deps.stderr(
            "Second signal: finishing the write in progress, then exiting (a third signal or 10 s forces it).",
          );
          pendingExit = SIGNAL_EXIT[first];
          const code = pendingExit;
          startTimer(() => {
            deps.stderr("Write still in progress after the cap: exiting now.");
            quit(code);
          }, forceQuitMs);
          return;
        }
        deps.stderr("Second signal: exiting without writing more.");
        quit(SIGNAL_EXIT[first]);
        return;
      }
      first = received;
      deps.stderr(
        `${received}: stopping now; the row being sent is left UNCERTAIN (press again to quit without writing).`,
      );
      deps.abort();
    },
    /** Marks an atomic write as running; call the result when it ended. */
    beginWrite(): () => void {
      writing += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        writing -= 1;
        if (writing === 0 && pendingExit !== undefined) quit(pendingExit);
      };
    },
  };
}
