import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { exitWithParent } from "../../scripts/exit-with-parent-lib.mjs";

const guard = resolve(
  import.meta.dirname,
  "../../scripts/exit-with-parent.mjs",
);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A launcher process that spawns an idle child (with or without the guard) over
 * an IPC channel, as e2e-backend.mjs does. Resolves the child pid and the
 * launcher, which the test then SIGKILLs.
 */
async function startLauncher(withGuard: boolean) {
  const imports = withGuard ? `["--import", ${JSON.stringify(guard)}]` : "[]";
  const launcher = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, [...${imports}, "-e", "console.log('CHILD ' + process.pid); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
    child.stdout.on("data", (d) => process.stdout.write(d));
    setInterval(() => {}, 1000);
  `;
  const proc = spawn(process.execPath, ["-e", launcher], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const pid = await new Promise<number>((resolvePid, rejectPid) => {
    let out = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /CHILD (\d+)/.exec(out);
      if (match) resolvePid(Number(match[1]));
    });
    proc.once("error", rejectPid);
    proc.once("exit", () => rejectPid(new Error("launcher exited early")));
  });
  return { proc, pid };
}

async function waitDead(pid: number, tries = 60) {
  for (let i = 0; i < tries && alive(pid); i += 1)
    await new Promise((done) => setTimeout(done, 50));
  return !alive(pid);
}

describe("exit-with-parent (CR-427)", () => {
  it("control: without the guard a child outlives a SIGKILLed launcher", async () => {
    const { proc, pid } = await startLauncher(false);
    try {
      proc.kill("SIGKILL");
      expect(await waitDead(pid, 20)).toBe(false);
    } finally {
      process.kill(pid, "SIGKILL");
    }
  });

  it("with the guard the child exits when the launcher is SIGKILLed", async () => {
    const { proc, pid } = await startLauncher(true);
    try {
      proc.kill("SIGKILL");
      expect(await waitDead(pid)).toBe(true);
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("does nothing without an IPC channel and exits on disconnect with one", () => {
    expect(exitWithParent({ connected: false } as never)).toBe(false);
    const handlers: Record<string, () => void> = {};
    const codes: number[] = [];
    const fake = {
      connected: true,
      channel: { unref: () => undefined },
      on: (event: string, handler: () => void) => (handlers[event] = handler),
    };
    expect(exitWithParent(fake as never, (code) => codes.push(code))).toBe(
      true,
    );
    handlers.disconnect?.();
    expect(codes).toEqual([1]);
  });
});
