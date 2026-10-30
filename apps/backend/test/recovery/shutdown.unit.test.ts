import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The server never connects to PostgreSQL at startup, so an unreachable
// DATABASE_URL is enough to prove the shutdown path end to end.
function runServer(signal: NodeJS.Signals) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve("src/server.ts")],
    {
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: "postgresql://nobody:nothing@127.0.0.1:1/none",
        HOST: "127.0.0.1",
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  return new Promise<{
    code: number | null;
    elapsedMs: number;
    output: string;
  }>((resolveRun, reject) => {
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not exit after ${signal}:\n${output}`));
    }, 15_000);
    let signalledAt = 0;
    child.stdout.on("data", () => {
      if (signalledAt === 0 && output.includes("listening on")) {
        signalledAt = Date.now();
        child.kill(signal);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(guard);
      resolveRun({
        code,
        elapsedMs: signalledAt === 0 ? -1 : Date.now() - signalledAt,
        output,
      });
    });
  });
}

describe("graceful shutdown", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "exits 0 quickly on %s and logs one JSON shutdown line",
    async (signal) => {
      const result = await runServer(signal);

      expect(result.code).toBe(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(result.elapsedMs).toBeLessThan(5000);
      const lines = result.output
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, string>);
      const shutdown = lines.filter((line) => line.event === "shutdown");
      expect(shutdown).toHaveLength(1);
      expect(shutdown[0]).toMatchObject({
        level: "info",
        reason: signal,
        outcome: "clean",
      });
    },
    20_000,
  );
});
