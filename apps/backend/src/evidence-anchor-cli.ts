import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { AuthError, createAuthService } from "./auth.js";
import { createDatabase } from "./database.js";
import {
  createEvidenceAnchorCommand,
  parseEvidenceAnchorCommand,
} from "./evidence-anchor-command.js";
import { createEvidenceAnchorObservations } from "./evidence-anchor-observations.js";
import { createEvidenceAnchorReservation } from "./evidence-anchor-reservation.js";
import { createEvidenceAnchorTransactions } from "./evidence-anchor-transactions.js";
import {
  createEvidencePersistence,
  EvidenceIntegrityError,
} from "./evidence-persistence.js";
import { EvidencePersistenceError, authorizeContext } from "./invoices.js";
import { createEvidenceAnchorRuntime } from "./evidence-anchor-runtime.js";
import { EvidenceAnchorConfigurationError } from "./evidence-anchor-config.js";

const HELP = `Usage:
  pnpm --filter @invoiceops/backend evidence-anchor --help
  pnpm --filter @invoiceops/backend evidence-anchor anchor --batch-id ID --organization-id ID --owner-type user|group --owner-id ID
  pnpm --filter @invoiceops/backend evidence-anchor reconcile --batch-id ID --organization-id ID --owner-type user|group --owner-id ID --reservation-id ID

Authentication: APP_SESSION_TOKEN environment variable.
Anchor configuration: EVM_RPC_URL, EVM_CHAIN_ID, EVIDENCE_CONTRACT_ADDRESS, EVM_SIGNER_PRIVATE_KEY.
Reconciliation does not read EVM_SIGNER_PRIVATE_KEY. Configure EVM_RPC_URL, EVM_CHAIN_ID, and EVIDENCE_CONTRACT_ADDRESS.
Exit statuses: 0 completed, 1 authentication/data/provider failure, 2 usage/configuration failure.
The CLI never reports a broadcast as confirmed; reconciliation observations are provisional.
`;

type EvidenceAnchorCliDiagnostic = {
  phase: "input" | "database" | "execute" | "cleanup";
  operation: "anchor" | "reconcile" | "command";
  reason:
    | "usage"
    | "authentication"
    | "configuration"
    | "database"
    | "data"
    | "operation"
    | "cleanup";
  outcome: "failed";
};

function reportDiagnostic(
  diagnostic: ((event: EvidenceAnchorCliDiagnostic) => void) | undefined,
  event: EvidenceAnchorCliDiagnostic,
) {
  try {
    diagnostic?.(event);
  } catch {
    // Diagnostics are best-effort and must not change the CLI result.
  }
}

function safeOutput(result: Record<string, unknown>): string {
  const publicFields = [
    "action",
    "kind",
    "reason",
    "batchId",
    "rootHash",
    "blockNumber",
    "blockHash",
    "receiptStatus",
  ];
  const output = Object.fromEntries(
    publicFields
      .filter((field) => field in result)
      .map((field) => {
        const value = result[field];
        return [field, typeof value === "bigint" ? value.toString() : value];
      }),
  );
  return JSON.stringify(output);
}

export async function runEvidenceAnchorCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  output: (line: string) => void = console.log,
  diagnostic?: (event: EvidenceAnchorCliDiagnostic) => void,
  ports: { createDatabase?: typeof createDatabase } = {},
): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    output(HELP);
    return 0;
  }
  let phase: EvidenceAnchorCliDiagnostic["phase"] = "database";
  const operation: EvidenceAnchorCliDiagnostic["operation"] =
    args[0] === "anchor" || args[0] === "reconcile" ? args[0] : "command";
  let cleanupFailed = false;
  try {
    parseEvidenceAnchorCommand(args);
  } catch {
    reportDiagnostic(diagnostic, {
      phase: "input",
      operation,
      reason: "usage",
      outcome: "failed",
    });
    output(JSON.stringify({ error: "INVALID_USAGE" }));
    return 2;
  }
  try {
    const databaseUrl = environment.DATABASE_URL;
    if (!databaseUrl) {
      reportDiagnostic(diagnostic, {
        phase: "database",
        operation,
        reason: "database",
        outcome: "failed",
      });
      output(JSON.stringify({ error: "DATABASE_UNAVAILABLE" }));
      return 2;
    }
    const database = (ports.createDatabase ?? createDatabase)(databaseUrl);
    let commandFailed = false;
    let result: Record<string, unknown>;
    try {
      phase = "execute";
      const { prisma } = database;
      const auth = createAuthService(prisma);
      const evidence = createEvidencePersistence(prisma);
      const reservation = createEvidenceAnchorReservation(prisma);
      const transactions = createEvidenceAnchorTransactions(prisma);
      const observations = createEvidenceAnchorObservations(prisma);
      const command = createEvidenceAnchorCommand({
        authenticateSession: (token) => auth.getProfile(token),
        data: {
          ...evidence,
          ...reservation,
          ...transactions,
          ...observations,
          authorizeContext: (actorId, context) =>
            authorizeContext(prisma, actorId, context),
        },
        createEvmRuntime: (config, action) =>
          createEvidenceAnchorRuntime(config, action),
      });
      result = await command.execute(args, environment);
    } catch (error) {
      commandFailed = true;
      throw error;
    } finally {
      if (!commandFailed) phase = "cleanup";
      try {
        await database.prisma.$disconnect();
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      reportDiagnostic(diagnostic, {
        phase: "cleanup",
        operation,
        reason: "cleanup",
        outcome: "failed",
      });
    }
    output(safeOutput(result));
    return 0;
  } catch (error) {
    const configurationFailure =
      error instanceof EvidenceAnchorConfigurationError;
    const reason: EvidenceAnchorCliDiagnostic["reason"] = configurationFailure
      ? "configuration"
      : phase === "cleanup"
        ? "cleanup"
        : phase === "database"
          ? "database"
          : error instanceof AuthError
            ? error.status === 401
              ? "authentication"
              : "data"
            : error instanceof EvidencePersistenceError ||
                error instanceof EvidenceIntegrityError
              ? "data"
              : "operation";
    reportDiagnostic(diagnostic, {
      phase,
      operation,
      reason,
      outcome: "failed",
    });
    if (cleanupFailed) {
      reportDiagnostic(diagnostic, {
        phase: "cleanup",
        operation,
        reason: "cleanup",
        outcome: "failed",
      });
    }
    if (configurationFailure) {
      output(JSON.stringify({ error: "EVIDENCE_ANCHOR_CONFIG_INVALID" }));
      return 2;
    }
    output(JSON.stringify({ error: "EVIDENCE_ANCHOR_FAILED" }));
    return 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runEvidenceAnchorCli(
    process.argv.slice(2),
    process.env,
    console.log,
    (event) => {
      console.error(
        `EVIDENCE_ANCHOR_DIAGNOSTIC phase=${event.phase} operation=${event.operation} reason=${event.reason} outcome=${event.outcome}`,
      );
    },
  ).then((status) => {
    process.exitCode = status;
  });
}
