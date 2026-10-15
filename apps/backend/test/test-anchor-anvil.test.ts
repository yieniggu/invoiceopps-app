import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";

import {
  assertOwnedListener,
  formatSmokeFailure,
  reportSmokeFailure,
  runOwnedChild,
  stopOwnedChild,
} from "../scripts/test-anchor-anvil.mjs";

describe("owned smoke failure diagnostics", () => {
  it("formats only closed-domain child and CLI metadata", () => {
    const marker = formatSmokeFailure({
      step: "full-cli-anchor-child",
      cause: "child-exit-nonzero",
      status: 1,
      signal: "SIGTERM",
      spawnCode: "ENOENT",
      cliPhase: "execute",
      cliOperation: "anchor",
      cliReason: "operation",
      phase: "anchor",
      method: "eth_sendRawTransaction",
      message: "raw-url token private-key SQL and RPC payload",
      argv: ["sensitive argument"],
      absolutePath: "/private/path",
    });

    expect(marker).toBe(
      "SMOKE_FAILURE step=full-cli-anchor-child cause=child-exit-nonzero status=1 signal=SIGTERM spawn_code=ENOENT cli_phase=execute cli_operation=anchor cli_reason=operation phase=anchor method=eth_sendRawTransaction",
    );
    expect(marker).not.toMatch(
      /raw-url|token|private-key|SQL|RPC|sensitive|private\/path/,
    );
  });

  it("replaces unknown child values with safe defaults", () => {
    const marker = formatSmokeFailure({
      step: "secret-step",
      cause: "secret-cause",
      status: "1 secret",
      signal: "secret-signal",
      spawnCode: "secret-code",
      cliPhase: "secret-phase",
      cliOperation: "secret-operation",
      cliReason: "secret-reason",
      phase: "secret-phase",
      method: "secret-method",
    });

    expect(marker).toBe(
      "SMOKE_FAILURE step=smoke-assertions cause=child-process-failed status=none signal=none spawn_code=none cli_phase=none cli_operation=none cli_reason=none phase=setup method=unknown",
    );
    expect(marker).not.toContain("secret");
  });

  it("keeps child timeouts distinct from spawn failures and nonzero exits", () => {
    expect(
      formatSmokeFailure({
        step: "full-cli-reconcile-child",
        cause: "child-timeout",
        spawnCode: "ETIMEDOUT",
        phase: "full-cli-reconcile",
      }),
    ).toContain(
      "SMOKE_FAILURE step=full-cli-reconcile-child cause=child-timeout status=none signal=none spawn_code=ETIMEDOUT",
    );
  });

  it("reports only safe metadata and returns the original assertion error", () => {
    const original = new Error(
      "session token and signed payload must stay hidden",
    );
    const output: string[] = [];

    expect(
      reportSmokeFailure(
        original,
        { step: "anchor-assertions", cause: "assertion-failed" },
        (marker) => output.push(marker),
      ),
    ).toBe(original);
    expect(output).toEqual([
      "SMOKE_FAILURE step=anchor-assertions cause=assertion-failed status=none signal=none spawn_code=none cli_phase=none cli_operation=none cli_reason=none phase=setup method=unknown",
    ]);
    expect(output.join("\n")).not.toContain("session token");
    expect(output.join("\n")).not.toContain("signed payload");
  });
});

describe("own-local Anvil listener boundary", () => {
  const own =
    "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nanvil 123 user 8u IPv4 0x00 0t0 TCP 127.0.0.1:45678 (LISTEN)";

  it("accepts only the captured PID and exact loopback port", () => {
    expect(() => assertOwnedListener(own, 123, 45678)).not.toThrow();
    for (const candidate of [
      own.replace("anvil 123", "anvil 999"),
      own.replace("127.0.0.1", "0.0.0.0"),
      own.replace("45678", "45679"),
      `${own}\nforeign 999 user 8u IPv4 0x00 0t0 TCP 127.0.0.1:45678 (LISTEN)`,
      "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
    ]) {
      expect(() => assertOwnedListener(candidate, 123, 45678)).toThrow();
    }
    expect(() => assertOwnedListener(own, -1, 45678)).toThrow();
  });
});

describe("owned child signal cleanup without starting a process", () => {
  class FakeChild extends EventEmitter {
    readonly pid = 123;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    signals: NodeJS.Signals[] = [];

    kill(signal: NodeJS.Signals): boolean {
      this.signals.push(signal);
      this.signalCode = signal;
      this.emit("exit", null, signal);
      this.emit("close", null, signal);
      return true;
    }
  }

  it("recognizes a synchronous SIGTERM exit with null exitCode and never kills twice", async () => {
    const child = new FakeChild();
    expect(await stopOwnedChild(child)).toBe(true);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGTERM");
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("does not signal a child that already exited normally or on a signal", async () => {
    const normal = new FakeChild();
    normal.exitCode = 0;
    expect(await stopOwnedChild(normal)).toBe(true);
    expect(normal.signals).toEqual([]);

    const signaled = new FakeChild();
    signaled.signalCode = "SIGINT";
    expect(await stopOwnedChild(signaled)).toBe(true);
    expect(signaled.signals).toEqual([]);
  });
});

describe("owned asynchronous CLI child execution", () => {
  it("keeps the parent HTTP event loop responsive while the child requests it", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/plain" }).end("relay-ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Test relay did not bind an ephemeral loopback port");
      const result = await runOwnedChild(
        process.execPath,
        [
          "-e",
          "(async () => { const response = await fetch(process.argv[1]); process.stdout.write(await response.text()); })()",
          `http://127.0.0.1:${address.port}`,
        ],
        { env: {}, timeoutMs: 5_000 },
      );
      expect(result).toMatchObject({
        status: 0,
        signal: null,
        spawnCode: undefined,
        timedOut: false,
        outputLimitExceeded: false,
        stdout: "relay-ok",
      });
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("terminates and verifies timeout and output-limit process groups", async () => {
    const timeout = await runOwnedChild(
      process.execPath,
      [
        "-e",
        "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)",
      ],
      { env: {}, timeoutMs: 100 },
    );
    expect(timeout).toMatchObject({ timedOut: true, status: null });
    expect(["SIGTERM", "SIGKILL"]).toContain(timeout.signal);

    const oversized = await runOwnedChild(
      process.execPath,
      [
        "-e",
        "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)",
      ],
      { env: {}, timeoutMs: 5_000, maxOutputBytes: 1_024 },
    );
    expect(oversized).toMatchObject({
      timedOut: false,
      outputLimitExceeded: true,
      status: null,
    });
    expect(oversized.stdout).toBe("");
  });
});
