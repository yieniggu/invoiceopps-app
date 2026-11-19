export const SIGNAL_EXIT: { SIGHUP: 129; SIGINT: 130; SIGTERM: 143 };

export function launcherExitCode(params: {
  stopping: number | undefined;
  code: number | null;
  signal: string | null;
}): number;

export const FORCE_KILL_MS: 10000;

interface KillableChild {
  exitCode: number | null;
  signalCode: string | null;
  kill(signal: string): unknown;
  once(event: "exit", listener: () => void): unknown;
}

export function forceKillAfter(
  child: KillableChild,
  options?: {
    graceMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (timer: unknown) => void;
  },
): unknown;

export function exitOnChildError(
  child: { on(event: "error", listener: (error: Error) => void): unknown },
  options: {
    label: string;
    stage: (message: string) => void;
    getStopping: () => number | undefined;
    exit: (code: number) => void;
  },
): void;
