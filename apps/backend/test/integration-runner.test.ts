import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";
import {
  assertMigrationLedger,
  expectedMigrationChecksums,
  runIntegrationGate,
  type GateDependencies,
  type MigrationLedgerRow,
} from "../scripts/test-integration.mjs";

const runner = resolve("scripts/test-integration.mjs");
const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

// Keep each owned child below Vitest's unchanged 5-second test budget. Await
// both captured output and close, including after timeout or test cleanup.
function startBoundedChild(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = 3000,
) {
  let complete!: (output: {
    error: ExecFileException | null;
    stdout: string;
    stderr: string;
  }) => void;
  const output = new Promise<Parameters<typeof complete>[0]>((resolve) => {
    complete = resolve;
  });
  const child = execFile(
    process.execPath,
    args,
    { env, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 65536 },
    (error, stdout, stderr) => complete({ error, stdout, stderr }),
  );
  const closed = new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  const result = Promise.all([output, closed]).then(([output, exit]) => ({
    ...output,
    ...exit,
  }));
  return {
    result,
    async stop() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await result;
    },
  };
}

describe("integration gate entry point", () => {
  it("uses the repository-owned orchestrator and explicitly selects the PostgreSQL suite", () => {
    expect(manifest.scripts["test:integration"]).toBe(
      "node scripts/test-integration.mjs",
    );
    const source = readFileSync(runner, "utf8");
    expect(source).toContain("organization-persistence.integration.test.ts");
  });

  // Independent unsafe-input contracts each own exactly one subprocess and its
  // cleanup; three synchronous launches no longer share one test's deadline.
  it.each([
    [
      "TEST_DATABASE_URL",
      {
        TEST_DATABASE_URL:
          "postgresql://invoiceops:secret@localhost:5436/invoiceops_test",
      },
      [],
    ],
    [
      "DATABASE_URL",
      {
        DATABASE_URL:
          "postgresql://invoiceops:secret@localhost:5432/invoiceops",
      },
      [],
    ],
    [
      "--database arguments",
      {},
      [
        "--database",
        "postgresql://invoiceops:secret@localhost:5436/invoiceops_test",
      ],
    ],
  ] as const)(
    "rejects %s before any Docker operation",
    async (_name, extra, args) => {
      const child = startBoundedChild([runner, ...args], {
        PATH: "",
        ...extra,
      });
      onTestFinished(child.stop);
      const result = await child.result;
      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.error).toMatchObject({ code: 1, killed: false });
      expect(result.stderr.trim()).toBe(
        "Integration gate rejects arguments and preconfigured database targets",
      );
      expect(result.stderr).not.toContain("secret");
      expect(result.stdout).not.toContain("secret");
      expect(result.stdout).not.toContain("stage:");
    },
  );

  it("kills and settles a timed-out owned child", async () => {
    const child = startBoundedChild(
      ["-e", "setInterval(() => {}, 1000)"],
      { PATH: "" },
      100,
    );
    onTestFinished(child.stop);
    const result = await child.result;
    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    expect(result.error).toMatchObject({ killed: true });
    await child.stop();
  });

  it("settles early cleanup without killing another case's child", async () => {
    const first = startBoundedChild(["-e", "setInterval(() => {}, 1000)"], {
      PATH: "",
    });
    const second = startBoundedChild(
      ["-e", "process.stdout.write('independent-child')"],
      { PATH: "" },
    );
    onTestFinished(first.stop);
    onTestFinished(second.stop);
    await first.stop();
    expect((await first.result).signal).toBe("SIGKILL");
    const result = await second.result;
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.error).toBeNull();
    expect(result.stdout).toBe("independent-child");
  });
});

const migrationDirectory = resolve("prisma/migrations");
const baseline = "20261026000000_initial_recovery_p0";
const names = readdirSync(migrationDirectory)
  .filter((entry) => /^\d{14}_/.test(entry))
  .sort();
const expected = expectedMigrationChecksums(migrationDirectory, names);
const completed = (count: number): MigrationLedgerRow[] =>
  expected.slice(0, count).map((row) => ({
    ...row,
    finished_at: new Date(),
    rolled_back_at: null,
  }));

describe("integration migration ledger", () => {
  it("hashes exact migration SQL bytes and accepts only completed matching rows", () => {
    expect(expected[0].checksum).toBe(
      createHash("sha256")
        .update(
          readFileSync(resolve(migrationDirectory, baseline, "migration.sql")),
        )
        .digest("hex"),
    );
    const all = completed(names.length);
    expect(() => assertMigrationLedger(all, expected)).not.toThrow();
    // Each case keeps the full row count and alters one field of the last
    // row, so a failure can only come from the field under test.
    const alterLast = (change: Partial<MigrationLedgerRow>) =>
      all.map((row, index) =>
        index === all.length - 1 ? { ...row, ...change } : row,
      );
    for (const altered of [
      alterLast({ checksum: "0".repeat(64) }),
      alterLast({ migration_name: "wrong" }),
      alterLast({ finished_at: null }),
      alterLast({ rolled_back_at: new Date() }),
    ]) {
      expect(altered).toHaveLength(all.length);
      expect(() => assertMigrationLedger(altered, expected)).toThrow(
        "Migration ledger name, checksum or status mismatch",
      );
    }
    // Length mismatches: missing and duplicated rows.
    for (const altered of [[], all.slice(0, -1), [...all, all[0]]]) {
      expect(() => assertMigrationLedger(altered, expected)).toThrow(
        "Migration ledger name, checksum or status mismatch",
      );
    }
  });

  it("ships the consolidated baseline migration first", () => {
    expect(names[0]).toBe(baseline);
    expect(expected[0].migration_name).toBe(baseline);
  });
});

function fixture({
  failure,
}: {
  failure?: "checksum" | "suite" | "unowned" | "cleanup" | "organization-count";
} = {}) {
  const calls: Array<{
    binary: string;
    args: readonly string[];
    options: { timeout: number; env?: NodeJS.ProcessEnv };
  }> = [];
  const queries: string[] = [];
  const logs: string[] = [];
  const id = "a".repeat(64);
  let nonce = "";
  let created = false;
  let migrationCount = 0;
  class Client {
    constructor(_options: {
      connectionString: string;
      connectionTimeoutMillis: number;
    }) {}
    async connect() {}
    async end() {}
    async query(sql: string): Promise<{ rows: object[]; rowCount?: number }> {
      queries.push(sql);
      if (sql.includes('FROM "_prisma_migrations"')) {
        const rows = completed(migrationCount);
        if (failure === "checksum") rows[0].checksum = "f".repeat(64);
        return { rows };
      }
      return { rows: [] };
    }
  }
  const spawn: NonNullable<GateDependencies["spawn"]> = (
    binary,
    args,
    options,
  ) => {
    calls.push({ binary, args, options });
    const success = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (binary === "docker") {
      switch (args[0]) {
        case "create":
          nonce = String(args[args.indexOf("--label") + 1]).split("=")[1];
          created = true;
          return success(id);
        case "inspect":
          if (!created)
            return { status: 1, stdout: "", stderr: "No such object" };
          if (args[1] === id)
            return success(
              JSON.stringify({
                "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55001" }],
              }),
            );
          return success(
            JSON.stringify({
              Id: id,
              Config: {
                Labels: {
                  "invoiceops.integration.owner":
                    failure === "unowned" ? "foreign" : nonce,
                },
              },
            }),
          );
        case "rm":
          if (failure === "cleanup")
            return {
              status: 1,
              stdout: "",
              stderr: "synthetic cleanup failure",
            };
          created = false;
          return success(id);
        default:
          return success();
      }
    }
    if (args.includes("migrate")) {
      migrationCount = names.length;
      return success();
    }
    if (args.includes("vitest")) {
      if (failure === "suite")
        return { status: 1, stdout: "", stderr: "synthetic suite failure" };
      const count = failure === "organization-count" ? 22 : 26;
      return success(`Tests  ${count} passed (${count})`);
    }
    return success();
  };
  return {
    calls,
    queries,
    logs,
    dependencies: {
      argv: ["node", runner],
      env: { PATH: "/nonexistent", HOME: "/nonexistent" },
      spawn,
      Client,
      log: (message: string) => logs.push(message),
    } satisfies GateDependencies,
  };
}

describe("integration runner orchestration without external processes", () => {
  it("imports without executing and rejects unsafe input before spawning or allocating resources", async () => {
    const { dependencies, calls } = fixture();
    await expect(
      runIntegrationGate({
        ...dependencies,
        env: { ...dependencies.env, TEST_DATABASE_URL: "unsafe" },
      }),
    ).rejects.toThrow("rejects arguments and preconfigured database targets");
    expect(calls).toEqual([]);
  });

  it("verifies the migration ledger, passes explicit timeouts and removes only the owned ID", async () => {
    const { dependencies, calls, queries, logs } = fixture();
    await runIntegrationGate(dependencies);
    expect(
      queries.filter((query) => query.includes('FROM "_prisma_migrations"')),
    ).toHaveLength(1);
    const suites = calls.filter(({ args }) => args.includes("vitest"));
    expect(suites.map(({ args }) => args[3])).toEqual([
      "test/organization-persistence.integration.test.ts",
    ]);
    for (const { args, options } of suites) {
      expect(args).toEqual(
        expect.arrayContaining([
          "--testTimeout",
          "60000",
          "--hookTimeout",
          "120000",
        ]),
      );
      expect(options.timeout).toBe(300_000);
    }
    expect(calls.filter(({ args }) => args[0] === "rm")).toEqual([
      expect.objectContaining({
        binary: "docker",
        args: ["rm", "--force", "a".repeat(64)],
      }),
    ]);
    expect(logs).toEqual(
      expect.arrayContaining([
        "stage: organization 26 passed",
        "stage: migrations",
        "cleanup: exact owned container removed and absence verified",
      ]),
    );
  });

  it("dispatches the organization suite only after the migrations using the normal gate", async () => {
    const { dependencies, calls } = fixture();
    await runIntegrationGate(dependencies);
    const runs = calls.filter(({ args }) =>
      args.includes("test/organization-persistence.integration.test.ts"),
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      binary: "pnpm",
      args: [
        "exec",
        "vitest",
        "run",
        "test/organization-persistence.integration.test.ts",
        "--testTimeout",
        "60000",
        "--hookTimeout",
        "120000",
      ],
      options: { timeout: 300000 },
    });
    const fullMigration = calls.findIndex(
      ({ args }) => args.includes("migrate") && args.includes("deploy"),
    );
    expect(fullMigration).toBeGreaterThan(-1);
    expect(calls.indexOf(runs[0])).toBeGreaterThan(fullMigration);
    const environment = runs[0].options.env!;
    expect(environment.APP10_TEST_NAMESPACE).toMatch(/^[a-f0-9]{10}$/);
    const url = new URL(environment.TEST_DATABASE_URL!);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/invoiceops_test");
    expect(url.username).toBe(`evi_${environment.APP10_TEST_NAMESPACE}`);
    expect(environment.DATABASE_URL).toBeUndefined();
  });

  it("requires the three group catalog SQL cases in the normal organization gate", async () => {
    const { dependencies, logs } = fixture({ failure: "organization-count" });
    await expect(runIntegrationGate(dependencies)).rejects.toThrow(
      "organization suite did not pass all 26 expected cases",
    );
    expect(logs).not.toContain("stage: organization 26 passed");
    expect(logs).toContain(
      "cleanup: exact owned container removed and absence verified",
    );
  });

  it.each([
    ["checksum", "Migration ledger name, checksum or status mismatch", true],
    ["suite", "organization suite failed or timed out", true],
    ["unowned", "Container ownership could not be verified", false],
    ["cleanup", "owned container cleanup failed or timed out", true],
  ] as const)(
    "fails closed on %s and never reports a false PASS",
    async (failure, message, removes) => {
      const { dependencies, calls, logs } = fixture({ failure });
      await expect(runIntegrationGate(dependencies)).rejects.toThrow(message);
      expect(calls.filter(({ args }) => args[0] === "rm")).toHaveLength(
        removes ? 1 : 0,
      );
      if (failure !== "cleanup")
        expect(logs).not.toContain("stage: organization 26 passed");
      if (removes && failure !== "cleanup") {
        expect(logs).toContain(
          "cleanup: exact owned container removed and absence verified",
        );
      } else {
        expect(logs).not.toContain(
          "cleanup: exact owned container removed and absence verified",
        );
      }
      if (failure === "checksum")
        expect(calls.some(({ args }) => args.includes("vitest"))).toBe(false);
      if (failure === "suite")
        expect(
          calls.filter(({ args }) => args.includes("vitest")),
        ).toHaveLength(1);
    },
  );
});
