import { AuthError, type AuthProfile, type AuthUser } from "./auth.js";
import {
  readEvidenceAnchorConfig,
  EvidenceAnchorConfigurationError,
  type EvidenceAnchorAction,
  type EvidenceAnchorConfig,
  type EvidenceAnchorEnvironment,
} from "./evidence-anchor-config.js";
import { createEvidenceAnchor } from "./evidence-anchor.js";
import { createEvidenceAnchorClient } from "./evidence-anchor-client.js";
import type { EvidenceAnchorTransport } from "./evidence-anchor-client.js";
import { createEvidenceAnchorReconciliation } from "./evidence-anchor-reconciliation.js";
import { createEvidenceAnchorReservation } from "./evidence-anchor-reservation.js";
import { createEvidenceAnchorTransactions } from "./evidence-anchor-transactions.js";
import { createEvidenceAnchorObservations } from "./evidence-anchor-observations.js";
import { createEvidencePersistence } from "./evidence-persistence.js";
import type { AnchorObservation } from "./evidence-anchor-reconciliation.js";
import type { ChainReader } from "./evidence-anchor-reconciliation.js";
import type { ResourceContext } from "./resources.js";

export interface EvidenceAnchorCommandInput {
  action: EvidenceAnchorAction;
  batchId: string;
  context: ResourceContext;
  reservationId?: string;
}

function invalidCommand(): never {
  throw new Error("Invalid evidence anchor command; run with --help");
}

function boundedValue(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

export function parseEvidenceAnchorCommand(
  args: readonly string[],
): EvidenceAnchorCommandInput {
  if (args.length < 1 || (args[0] !== "anchor" && args[0] !== "reconcile"))
    return invalidCommand();
  const action = args[0];
  const fields = new Map<string, string>();
  const forbidden = new Set([
    "--actor-id",
    "--private-key",
    "--rpc-url",
    "--session-token",
  ]);
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (forbidden.has(flag)) return invalidCommand();
    if (
      ![
        "--batch-id",
        "--organization-id",
        "--owner-type",
        "--owner-id",
        "--reservation-id",
      ].includes(flag) ||
      !boundedValue(value) ||
      fields.has(flag)
    )
      return invalidCommand();
    fields.set(flag, value);
  }
  const batchId = fields.get("--batch-id");
  const organizationId = fields.get("--organization-id");
  const ownerType = fields.get("--owner-type");
  const ownerId = fields.get("--owner-id");
  const reservationId = fields.get("--reservation-id");
  if (
    !boundedValue(batchId) ||
    !boundedValue(organizationId) ||
    (ownerType !== "user" && ownerType !== "group") ||
    !boundedValue(ownerId) ||
    (action === "reconcile" && !boundedValue(reservationId)) ||
    (action === "anchor" && reservationId !== undefined)
  )
    return invalidCommand();
  return {
    action,
    batchId,
    context: { organizationId, ownerType, ownerId },
    ...(reservationId ? { reservationId } : {}),
  };
}

export interface EvidenceAnchorCommandPorts {
  authenticateSession(token: string): Promise<AuthProfile>;
  data: Pick<ReturnType<typeof createEvidencePersistence>, "getBatch"> &
    Pick<
      ReturnType<typeof createEvidenceAnchorReservation>,
      "claimAnchorSubmission"
    > &
    Pick<
      ReturnType<typeof createEvidenceAnchorTransactions>,
      "acquireSignerPreparationSlot" | "persistPreparedTransaction"
    > &
    Pick<
      ReturnType<typeof createEvidenceAnchorObservations>,
      "readPrepared" | "latest" | "append"
    > & {
      authorizeContext(
        actorId: string,
        context: ResourceContext,
      ): Promise<void>;
    };
  createEvmRuntime(
    config: Extract<EvidenceAnchorConfig, { kind: "configured" }>,
    action: EvidenceAnchorAction,
  ): {
    transport: EvidenceAnchorTransport;
    chainReader: ChainReader;
  };
}

export function createEvidenceAnchorCommand(ports: EvidenceAnchorCommandPorts) {
  return {
    async execute(
      args: readonly string[],
      environment: EvidenceAnchorEnvironment & { APP_SESSION_TOKEN?: string },
    ) {
      const input = parseEvidenceAnchorCommand(args);
      const token = environment.APP_SESSION_TOKEN;
      if (!token || token.length > 512)
        throw new AuthError(401, "Unauthorized");
      const profile = await ports.authenticateSession(token);
      const actor: AuthUser = {
        id: profile.id,
        name: profile.name,
        rut: profile.rut,
      };
      await ports.data.authorizeContext(actor.id, input.context);
      const batch = await ports.data.getBatch(
        actor,
        input.context,
        input.batchId,
      );
      const config = readEvidenceAnchorConfig(environment, input.action);
      if (config.kind !== "configured")
        throw new EvidenceAnchorConfigurationError();
      if (input.action === "anchor") {
        if (!config.signerAddress || !config.getAccount)
          throw new Error("Evidence anchor signer unavailable");
        const runtime = ports.createEvmRuntime(config, input.action);
        const client = createEvidenceAnchorClient(
          { ...config.target, signerAddress: config.signerAddress },
          runtime.transport,
        );
        const persistence = {
          getBatch: ports.data.getBatch,
          claimAnchorSubmission: ports.data.claimAnchorSubmission,
          acquireSignerPreparationSlot: ports.data.acquireSignerPreparationSlot,
          persistPreparedTransaction: ports.data.persistPreparedTransaction,
        };
        const outcome = await createEvidenceAnchor(
          persistence,
          client,
        ).anchorBatch(actor, input.context, input.batchId);
        return {
          kind: outcome,
          action: input.action,
          batchId: batch.id,
          rootHash: batch.rootHash,
        };
      }
      if (!input.reservationId) return invalidCommand();
      const prepared = await ports.data.readPrepared(
        actor,
        input.context,
        input.batchId,
        input.reservationId,
      );
      if (
        prepared.chainId !== config.target.chainId ||
        prepared.contractAddress.toLowerCase() !==
          config.target.contractAddress.toLowerCase() ||
        prepared.rootHash.toLowerCase() !== batch.rootHash.toLowerCase()
      )
        throw new Error(
          "Evidence anchor target does not match prepared transaction",
        );
      const runtime = ports.createEvmRuntime(config, input.action);
      const reconciliation = createEvidenceAnchorReconciliation(
        {
          readPrepared: async () => prepared,
          latest: ports.data.latest,
          append: ports.data.append as (
            actor: AuthUser,
            context: ResourceContext,
            batchId: string,
            reservationId: string,
            observation: AnchorObservation,
          ) => Promise<AnchorObservation>,
        },
        runtime.chainReader,
      );
      const observation = await reconciliation.check(
        actor,
        input.context,
        input.batchId,
        input.reservationId,
        config.target,
      );
      return {
        ...observation,
        action: input.action,
        batchId: batch.id,
        rootHash: batch.rootHash,
      };
    },
  };
}
