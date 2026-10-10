import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
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

describe("integration gate entry point", () => {
  it("uses the repository-owned orchestrator and explicitly selects every PostgreSQL suite", () => {
    expect(manifest.scripts["test:integration"]).toBe(
      "node scripts/test-integration.mjs",
    );
    const source = readFileSync(runner, "utf8");
    for (const suite of [
      "evidence-persistence.integration.test.ts",
      "organization-persistence.integration.test.ts",
      "evidence-batches.integration.test.ts",
    ]) {
      expect(source).toContain(suite);
    }
  });

  it("rejects preconfigured database URLs and arguments before any Docker operation", () => {
    for (const [extra, args] of [
      [
        {
          TEST_DATABASE_URL:
            "postgresql://invoiceops:secret@localhost:5436/invoiceops_test",
        },
        [],
      ],
      [
        {
          DATABASE_URL:
            "postgresql://invoiceops:secret@localhost:5432/invoiceops",
        },
        [],
      ],
      [
        {},
        [
          "--database",
          "postgresql://invoiceops:secret@localhost:5436/invoiceops_test",
        ],
      ],
    ] as const) {
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: "" };
      delete env.DATABASE_URL;
      delete env.TEST_DATABASE_URL;
      delete env.APP10_TEST_NAMESPACE;
      Object.assign(env, extra);
      const result = spawnSync(process.execPath, [runner, ...args], {
        env,
        encoding: "utf8",
        timeout: 60_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Integration gate rejects arguments and preconfigured database targets",
      );
      expect(result.stderr).not.toContain("secret");
      expect(result.stdout).not.toContain("stage:");
    }
  });
});

const migrationDirectory = resolve("prisma/migrations");
const names = [
  "20260909214652_create_organization_memberships",
  "20260910120000_add_authentication",
  "20260911170000_add_organization_groups",
  "20260912120000_add_resource_references",
  "20260921194000_add_invoices",
  "20260922213000_add_platform_administrator",
  "20260923203000_add_business_policies",
  "20260927213500_add_model_inference_audit",
  "20261008060000_add_evidence_persistence",
];
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
          readFileSync(resolve(migrationDirectory, names[0], "migration.sql")),
        )
        .digest("hex"),
    );
    expect(() =>
      assertMigrationLedger(completed(8), expected.slice(0, 8)),
    ).not.toThrow();
    expect(() => assertMigrationLedger(completed(9), expected)).not.toThrow();
    for (const altered of [
      completed(8).map((row, index) =>
        index === 3 ? { ...row, checksum: "0".repeat(64) } : row,
      ),
      completed(8).map((row, index) =>
        index === 3 ? { ...row, migration_name: "wrong" } : row,
      ),
      completed(8).slice(0, 7),
      completed(9),
      completed(8).map((row, index) =>
        index === 3 ? { ...row, finished_at: null } : row,
      ),
      completed(8).map((row, index) =>
        index === 3 ? { ...row, rolled_back_at: new Date() } : row,
      ),
    ]) {
      expect(() =>
        assertMigrationLedger(altered, expected.slice(0, 8)),
      ).toThrow("Migration ledger name, checksum or status mismatch");
    }
  });
});

function fixture({
  failure,
}: {
  failure?: "checksum" | "suite" | "unowned" | "cleanup";
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
    async query(sql: string): Promise<{ rows: object[] }> {
      queries.push(sql);
      if (sql.includes('FROM "_prisma_migrations"')) {
        const rows = completed(migrationCount);
        if (failure === "checksum") rows[0].checksum = "f".repeat(64);
        return { rows };
      }
      if (sql.includes("information_schema.columns")) {
        return {
          rows: Object.entries({
            User: ["id", "name", "rut"],
            Organization: ["id", "name", "slug", "updatedAt"],
            Invoice: [
              "id",
              "invoiceId",
              "organizationId",
              "ownerType",
              "ownerId",
              "createdByUserId",
              "vendorName",
              "invoiceAmountCents",
              "hasPurchaseOrder",
              "threeWayMatch",
              "vendorTenureDays",
              "previousIncidents12m",
              "bankAccountRecentlyChanged",
              "amountVsVendorMedian",
              "countryRisk",
              "updatedAt",
            ],
            DecisionEvent: [
              "id",
              "invoiceId",
              "actorUserId",
              "actorName",
              "actorRut",
              "correlationId",
              "decision",
              "mode",
              "ruleVersion",
            ],
          }).flatMap(([table_name, columns]) =>
            columns.map((column_name) => ({ table_name, column_name })),
          ),
        };
      }
      if (sql.includes('FROM "EvidenceRecord"'))
        return { rows: [{ total: 0 }] };
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
      migrationCount = args[args.indexOf("--config") + 1].includes("/baseline/")
        ? 8
        : 9;
      return success();
    }
    if (args.includes("vitest")) {
      if (failure === "suite")
        return { status: 1, stdout: "", stderr: "synthetic suite failure" };
      const count = args.some((arg) => arg.includes("evidence-persistence"))
        ? 10
        : args.some((arg) => arg.includes("organization-persistence"))
          ? 31
          : 7;
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

  it("verifies both ledgers, preserves order, passes explicit timeouts and removes only the owned ID", async () => {
    const { dependencies, calls, queries, logs } = fixture();
    await runIntegrationGate(dependencies);
    expect(
      queries.filter((query) => query.includes('FROM "_prisma_migrations"')),
    ).toHaveLength(2);
    expect(queries.findIndex((query) => query === "BEGIN")).toBeGreaterThan(
      queries.findIndex((query) => query.includes('FROM "_prisma_migrations"')),
    );
    const suites = calls.filter(({ args }) => args.includes("vitest"));
    expect(suites.map(({ args }) => args[3])).toEqual([
      "test/evidence-persistence.integration.test.ts",
      "test/organization-persistence.integration.test.ts",
      "test/evidence-batches.integration.test.ts",
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
        "stage: SQL 10 passed",
        "stage: organization 31 passed",
        "stage: batch 7 passed",
        "cleanup: exact owned container removed and absence verified",
      ]),
    );
  });

  it.each([
    ["checksum", "Migration ledger name, checksum or status mismatch", true],
    ["suite", "SQL suite failed or timed out", true],
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
        expect(logs).not.toContain("stage: batch 7 passed");
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
