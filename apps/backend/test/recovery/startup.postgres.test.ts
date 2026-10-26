import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const url = process.env.RECOVERY_TEST_DATABASE_URL;
if (!url) {
  throw new Error("RECOVERY_TEST_DATABASE_URL must be configured");
}

async function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resolvePort(typeof address === "object" && address ? address.port : 0),
      );
    });
  });
}

describe("server startup with only DATABASE_URL", () => {
  it("becomes ready with no ML, MLflow or blockchain environment", async () => {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [resolve("node_modules/tsx/dist/cli.mjs"), "src/server.ts"],
      {
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: url,
          PORT: String(port),
        },
        stdio: "ignore",
      },
    );
    try {
      let ready = false;
      for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
        await delay(500);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
          ready = response.status === 200;
        } catch {
          ready = false;
        }
      }
      expect(ready).toBe(true);
    } finally {
      child.kill("SIGTERM");
    }
  }, 60_000);
});
