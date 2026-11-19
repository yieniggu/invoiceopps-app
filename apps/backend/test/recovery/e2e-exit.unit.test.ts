import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  FORCE_KILL_MS,
  SIGNAL_EXIT,
  exitOnChildError,
  forceKillAfter,
  launcherExitCode,
} from "../../scripts/e2e-exit.mjs";

describe("e2e launcher exit code (CR-436)", () => {
  it("maps SIGHUP/SIGINT/SIGTERM to 128+N", () => {
    expect(SIGNAL_EXIT).toEqual({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 });
  });

  it("a received signal wins over a graceful 0 or a failing server code", () => {
    for (const [signal, code] of Object.entries(SIGNAL_EXIT)) {
      expect(launcherExitCode({ stopping: code, code: 0, signal: null })).toBe(
        code,
      );
      expect(launcherExitCode({ stopping: code, code: 1, signal: null })).toBe(
        code,
      );
      expect(launcherExitCode({ stopping: code, code: null, signal })).toBe(
        code,
      );
    }
  });

  it("without a received signal the server's code semantics stay", () => {
    expect(
      launcherExitCode({ stopping: undefined, code: 0, signal: null }),
    ).toBe(0);
    expect(
      launcherExitCode({ stopping: undefined, code: 3, signal: null }),
    ).toBe(3);
    expect(
      launcherExitCode({ stopping: undefined, code: null, signal: "SIGKILL" }),
    ).toBe(1);
    expect(
      launcherExitCode({ stopping: undefined, code: null, signal: null }),
    ).toBe(0);
  });
});

function fakeChild(state: {
  exitCode: number | null;
  signalCode: string | null;
}) {
  const child = Object.assign(new EventEmitter(), {
    ...state,
    kill: vi.fn(),
  });
  return child;
}

describe("e2e launcher force kill (CR-445)", () => {
  it("SIGKILLs a child that has not exited after the grace period", () => {
    const child = fakeChild({ exitCode: null, signalCode: null });
    let fire: () => void = () => undefined;
    let graceMs = 0;
    const unref = vi.fn();
    forceKillAfter(child, {
      setTimer: (fn, ms) => {
        fire = fn;
        graceMs = ms;
        return { unref };
      },
      clearTimer: () => undefined,
    });
    expect(graceMs).toBe(FORCE_KILL_MS);
    // Below Playwright's 10 s gracefulShutdown timeout (CR-450).
    expect(FORCE_KILL_MS).toBe(8_000);
    // The timer never keeps the launcher alive by itself (CR-451).
    expect(unref).toHaveBeenCalledTimes(1);
    fire();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not kill a child that already exited, and clears the timer on exit", () => {
    const child = fakeChild({ exitCode: null, signalCode: null });
    let fire: () => void = () => undefined;
    const clearTimer = vi.fn();
    const timer = {};
    forceKillAfter(child, {
      setTimer: (fn) => {
        fire = fn;
        return timer;
      },
      clearTimer,
    });
    child.exitCode = 0;
    child.emit("exit", 0, null);
    expect(clearTimer).toHaveBeenCalledWith(timer);
    fire();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("exits 1 with a stage line when a child errors, 128+N when stopping", () => {
    for (const [stopping, expected] of [
      [undefined, 1],
      [143, 143],
    ] as const) {
      const child = new EventEmitter();
      const stage = vi.fn();
      const exit = vi.fn();
      exitOnChildError(child, {
        label: "server",
        stage,
        getStopping: () => stopping,
        exit,
      });
      child.emit("error", Object.assign(new Error("boom"), { code: "ENOENT" }));
      expect(stage).toHaveBeenCalledWith("server error (ENOENT)");
      expect(exit).toHaveBeenCalledWith(expected);
    }
  });
});
