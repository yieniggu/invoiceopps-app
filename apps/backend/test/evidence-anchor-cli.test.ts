import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthError } from "../src/auth.js";

const { executeCommand } = vi.hoisted(() => ({
  executeCommand:
    vi.fn<
      (
        args: readonly string[],
        environment: NodeJS.ProcessEnv,
      ) => Promise<Record<string, unknown>>
    >(),
}));

vi.mock("../src/evidence-anchor-command.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/evidence-anchor-command.js")>();
  return {
    ...actual,
    createEvidenceAnchorCommand: vi.fn(() => ({ execute: executeCommand })),
  };
});

import { runEvidenceAnchorCli } from "../src/evidence-anchor-cli.js";
import type { Database } from "../src/database.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";

function databaseWithDisconnect(
  disconnect: () => Promise<void>,
  onDisconnect?: () => void,
): Database {
  return {
    isReady: async () => true,
    prisma: {
      $disconnect: async () => {
        onDisconnect?.();
        await disconnect();
      },
    } as unknown as PrismaClient,
  };
}

const commandArgs = [
  "anchor",
  "--batch-id",
  "batch",
  "--organization-id",
  "org",
  "--owner-type",
  "user",
  "--owner-id",
  "owner",
] as const;

const syntheticEnvironment = {
  DATABASE_URL: "postgresql://synthetic-user:synthetic-password@db.invalid/app",
  APP_SESSION_TOKEN: "synthetic-session-token",
  EVM_RPC_URL: "https://rpc.invalid/?token=synthetic-rpc-secret",
  EVM_SIGNER_PRIVATE_KEY: `0x${"a".repeat(64)}`,
};

function expectNoSensitiveOutput(
  output: readonly string[],
  diagnostics: readonly unknown[],
  additionalCanaries: readonly string[],
) {
  const serialized = JSON.stringify({ output, diagnostics });
  for (const canary of [
    ...Object.values(syntheticEnvironment),
    ...additionalCanaries,
  ]) {
    expect(serialized).not.toContain(canary);
  }
}

describe("evidence anchor CLI entry point", () => {
  afterEach(() => executeCommand.mockReset());

  it("prints help without requiring database or anchor configuration", async () => {
    const output: string[] = [];
    const status = await runEvidenceAnchorCli(["--help"], {}, (line) =>
      output.push(line),
    );

    expect(status).toBe(0);
    expect(output.join("\n")).toContain("Usage:");
    expect(output.join("\n")).toContain("APP_SESSION_TOKEN");
    expect(output.join("\n")).toContain("observations are provisional");
  });

  it("rejects invalid usage before initializing database services", async () => {
    const output: string[] = [];
    const diagnostics: unknown[] = [];
    const status = await runEvidenceAnchorCli(
      ["anchor", "--private-key", "synthetic-secret"],
      {},
      (line) => output.push(line),
      (event) => diagnostics.push(event),
    );

    expect(status).toBe(2);
    expect(output).toEqual([JSON.stringify({ error: "INVALID_USAGE" })]);
    expect(output.join("\n")).not.toContain("synthetic-secret");
    expect(diagnostics).toEqual([
      {
        phase: "input",
        operation: "anchor",
        reason: "usage",
        outcome: "failed",
      },
    ]);
  });

  it("reports missing database configuration using fixed diagnostics only", async () => {
    const output: string[] = [];
    const diagnostics: unknown[] = [];
    const status = await runEvidenceAnchorCli(
      [
        "anchor",
        "--batch-id",
        "synthetic-batch",
        "--organization-id",
        "synthetic-organization",
        "--owner-type",
        "user",
        "--owner-id",
        "synthetic-owner",
      ],
      {},
      (line) => output.push(line),
      (event) => diagnostics.push(event),
    );

    expect(status).toBe(2);
    expect(output).toEqual([JSON.stringify({ error: "DATABASE_UNAVAILABLE" })]);
    expect(diagnostics).toEqual([
      {
        phase: "database",
        operation: "anchor",
        reason: "database",
        outcome: "failed",
      },
    ]);
  });

  it("emits only fixed diagnostic categories and a generic public error on database setup failure", async () => {
    const output: string[] = [];
    const diagnostics: unknown[] = [];
    const status = await runEvidenceAnchorCli(
      [
        "anchor",
        "--batch-id",
        "batch",
        "--organization-id",
        "org",
        "--owner-type",
        "user",
        "--owner-id",
        "owner",
      ],
      {
        DATABASE_URL:
          "postgresql://synthetic-user:synthetic-password@db.invalid/app",
      },
      (line) => output.push(line),
      (event) => diagnostics.push(event),
      {
        createDatabase: () => {
          throw new Error("synthetic-password and internal database detail");
        },
      },
    );

    expect(status).toBe(1);
    expect(output).toEqual([
      JSON.stringify({ error: "EVIDENCE_ANCHOR_FAILED" }),
    ]);
    expect(JSON.stringify(output)).not.toContain("synthetic-password");
    expect(diagnostics).toEqual([
      {
        phase: "database",
        operation: "anchor",
        reason: "database",
        outcome: "failed",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("synthetic-password");
    expect(JSON.stringify(diagnostics)).not.toContain(
      "internal database detail",
    );
  });

  it("preserves the primary configuration failure when database cleanup also fails", async () => {
    const output: string[] = [];
    const diagnostics: unknown[] = [];
    const status = await runEvidenceAnchorCli(
      [
        "anchor",
        "--batch-id",
        "batch",
        "--organization-id",
        "org",
        "--owner-type",
        "user",
        "--owner-id",
        "owner",
      ],
      {
        DATABASE_URL:
          "postgresql://synthetic-user:synthetic-password@db.invalid/app",
        AUTH_MODE: "unsupported-mode",
      },
      (line) => output.push(line),
      (event) => diagnostics.push(event),
      {
        createDatabase: () =>
          databaseWithDisconnect(async () => {
            throw new Error("synthetic-cleanup-secret");
          }),
      },
    );

    expect(status).toBe(2);
    expect(output).toEqual([
      JSON.stringify({ error: "EVIDENCE_ANCHOR_CONFIG_INVALID" }),
    ]);
    expect(diagnostics).toEqual([
      {
        phase: "execute",
        operation: "anchor",
        reason: "configuration",
        outcome: "failed",
      },
      {
        phase: "cleanup",
        operation: "anchor",
        reason: "cleanup",
        outcome: "failed",
      },
    ]);
    expect(JSON.stringify({ output, diagnostics })).not.toContain(
      "synthetic-cleanup-secret",
    );
    expect(JSON.stringify({ output, diagnostics })).not.toContain(
      "synthetic-password",
    );
  });

  it("preserves an authentication failure and reports cleanup failure separately", async () => {
    executeCommand.mockRejectedValue(
      new AuthError(401, "synthetic-auth-message-secret"),
    );
    const output: string[] = [];
    const diagnostics: unknown[] = [];
    const status = await runEvidenceAnchorCli(
      commandArgs,
      syntheticEnvironment,
      (line) => output.push(line),
      (event) => diagnostics.push(event),
      {
        createDatabase: () =>
          databaseWithDisconnect(async () => {
            throw new Error("synthetic-cleanup-message-secret");
          }),
      },
    );

    expect(status).toBe(1);
    expect(output).toEqual([
      JSON.stringify({ error: "EVIDENCE_ANCHOR_FAILED" }),
    ]);
    expect(diagnostics).toEqual([
      {
        phase: "execute",
        operation: "anchor",
        reason: "authentication",
        outcome: "failed",
      },
      {
        phase: "cleanup",
        operation: "anchor",
        reason: "cleanup",
        outcome: "failed",
      },
    ]);
    expect(executeCommand).toHaveBeenCalledOnce();
    expectNoSensitiveOutput(output, diagnostics, [
      "synthetic-auth-message-secret",
      "synthetic-cleanup-message-secret",
    ]);
  });

  it("preserves a provider failure and reports cleanup failure without exposing provider details", async () => {
    executeCommand.mockRejectedValue(
      new Error("synthetic-provider-body-secret", {
        cause: new Error("synthetic-signed-payload-secret"),
      }),
    );
    const output: string[] = [];
    const diagnostics: unknown[] = [];
    const status = await runEvidenceAnchorCli(
      commandArgs,
      syntheticEnvironment,
      (line) => output.push(line),
      (event) => diagnostics.push(event),
      {
        createDatabase: () =>
          databaseWithDisconnect(async () => {
            throw new Error("synthetic-cleanup-message-secret");
          }),
      },
    );

    expect(status).toBe(1);
    expect(output).toEqual([
      JSON.stringify({ error: "EVIDENCE_ANCHOR_FAILED" }),
    ]);
    expect(diagnostics).toEqual([
      {
        phase: "execute",
        operation: "anchor",
        reason: "operation",
        outcome: "failed",
      },
      {
        phase: "cleanup",
        operation: "anchor",
        reason: "cleanup",
        outcome: "failed",
      },
    ]);
    expect(executeCommand).toHaveBeenCalledOnce();
    expectNoSensitiveOutput(output, diagnostics, [
      "synthetic-provider-body-secret",
      "synthetic-signed-payload-secret",
      "synthetic-cleanup-message-secret",
    ]);
  });

  it("emits one successful result after cleanup even when disconnect fails", async () => {
    executeCommand.mockResolvedValue({
      action: "reconcile",
      kind: "observedSuccess",
      batchId: "batch-42",
      rootHash: `0x${"b".repeat(64)}`,
      blockNumber: 42n,
    });
    const output: string[] = [];
    const diagnostics: unknown[] = [];
    const lifecycle: string[] = [];
    const status = await runEvidenceAnchorCli(
      [
        "reconcile",
        "--batch-id",
        "batch-42",
        "--organization-id",
        "org",
        "--owner-type",
        "user",
        "--owner-id",
        "owner",
        "--reservation-id",
        "reservation-42",
      ],
      syntheticEnvironment,
      (line) => {
        lifecycle.push("output");
        output.push(line);
      },
      (event) => diagnostics.push(event),
      {
        createDatabase: () =>
          databaseWithDisconnect(
            async () => {
              throw new Error("synthetic-cleanup-message-secret");
            },
            () => lifecycle.push("disconnect"),
          ),
      },
    );

    expect(status).toBe(0);
    expect(output).toEqual([
      JSON.stringify({
        action: "reconcile",
        kind: "observedSuccess",
        batchId: "batch-42",
        rootHash: `0x${"b".repeat(64)}`,
        blockNumber: "42",
      }),
    ]);
    expect(output).toHaveLength(1);
    expect(lifecycle).toEqual(["disconnect", "output"]);
    expect(diagnostics).toEqual([
      {
        phase: "cleanup",
        operation: "reconcile",
        reason: "cleanup",
        outcome: "failed",
      },
    ]);
    expect(executeCommand).toHaveBeenCalledOnce();
    expectNoSensitiveOutput(output, diagnostics, [
      "synthetic-cleanup-message-secret",
    ]);
    expect(output[0]).not.toContain("EVIDENCE_ANCHOR_FAILED");
  });
});
