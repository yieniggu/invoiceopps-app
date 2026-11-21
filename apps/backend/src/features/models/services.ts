import type {
  Deployment,
  Prisma,
  PrismaClient,
} from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import { logEvent } from "../../http/logging.js";
import {
  mapTransactionTimeout,
  runSerializable,
  SERIALIZABLE,
  TRANSACTION_TIMING,
} from "../../transactions.js";
import {
  authorizeModelsContext,
  notFound,
  scopeKeyOf,
  workspaceOf,
} from "./authorization.js";
import { defaultModelsConfig, type ModelsConfig } from "./config.js";
import {
  ModelApiCapacityError,
  ModelApiUnavailableError,
  type GateReport,
  type ModelApiClient,
  type ModelApiState,
} from "./model-api-client.js";
import {
  RegistryUnavailableError,
  type ModelRegistryClient,
} from "./registry-client.js";
import { GateReportSchema } from "./schemas.js";
import type {
  DeploymentCreateRequest,
  DeploymentDto,
  DeploymentListResponse,
  ModelListResponse,
  ModelsContext,
} from "./types.js";

/** A gate run that never reported back is treated as failed after this long. */
export const CHECK_STALE_AFTER_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const LIST_LIMIT = 100;
/** Stale CHECKING rows failed per sweep; the next sweep takes the rest. */
const MAX_SWEEP_BATCH = 200;
/**
 * Eager reloads per reconcile pass and how many run at once: each one re-runs
 * the gate on the Model API (CR-621), whose download gate is small. The rest
 * waits for the next pass.
 */
export const MAX_EAGER_RELOADS = 20;
export const EAGER_RELOAD_CONCURRENCY = 2;
/** At most one `models.reconcile_unavailable` warning per this interval. */
export const RECONCILE_UNAVAILABLE_WARN_INTERVAL_MS = 5 * 60 * 1000;
/** Deployment ids are UUIDs; only those are ever unloaded as orphans. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ModelsService {
  listModels(
    userId: string,
    context: ModelsContext,
  ): Promise<ModelListResponse>;
  listDeployments(
    userId: string,
    context: ModelsContext,
  ): Promise<DeploymentListResponse>;
  /**
   * Starts a deployment: records a CHECKING row (cap and rate limit enforced
   * transactionally), then asks the Model API to check and load the version.
   * A gate failure is a normal outcome (status FAILED with its reasons), not
   * an error.
   */
  deploy(
    userId: string,
    request: DeploymentCreateRequest,
  ): Promise<DeploymentDto>;
  /** Turns the scoring of new invoices on or off; `changed` false = no-op. */
  setInference(
    userId: string,
    context: ModelsContext,
    deploymentId: string,
    enabled: boolean,
  ): Promise<{ deployment: DeploymentDto; changed: boolean }>;
  /** Unloads and marks the deployment INACTIVE; history is kept. Idempotent. */
  remove(
    userId: string,
    context: ModelsContext,
    deploymentId: string,
  ): Promise<{ deployment: DeploymentDto; changed: boolean }>;
  /**
   * For internal callers (MLOPS-06): makes sure an ACTIVE deployment is loaded
   * in the Model API, re-running the gate when it was lost (restart). No
   * authorization: the caller already decided to use this deployment.
   */
  ensureLoaded(
    deploymentId: string,
    options?: { signal?: AbortSignal },
  ): Promise<"loaded" | "not_active" | "rejected" | "unavailable">;
  /**
   * One pass of the periodic maintenance (never called from a GET): fails the
   * CHECKING rows that never completed, quarantines deployments the Model API
   * quarantined, unloads models that no row owns (FAILED, INACTIVE, unknown)
   * and the models of organizations whose Models section (mlEnabled) is off.
   * ACTIVE deployments of organizations with the Models section on and scoring
   * on that the Model API no longer serves (restart) are reloaded eagerly
   * (CR-621), so the first prediction does not pay the gate.
   * Best effort: nothing is done while the Model API cannot be reached.
   * `signal` (graceful shutdown) aborts the Model API calls and stops the
   * pass between steps; what was not reached is retried by the next pass.
   */
  reconcile(options?: { signal?: AbortSignal }): Promise<ReconcileResult>;
}

export interface ReconcileResult {
  /** CHECKING rows marked FAILED. */
  swept: number;
  /** ACTIVE rows marked QUARANTINED. */
  quarantined: number;
  /** Models asked to unload from the Model API. */
  unloaded: number;
  /** Lost models loaded again eagerly (CR-621). */
  reloaded: number;
  /** False when the Model API could not be reached (only sweeping ran). */
  modelApiAvailable: boolean;
}

/** Deployments whose model stays loaded while their organization has ML on. */
const OWNED_STATUSES = ["ACTIVE", "QUARANTINED"] as const;

export interface ModelsServiceOptions {
  config?: ModelsConfig;
  modelApi?: ModelApiClient;
  registry?: ModelRegistryClient;
  now?: () => Date;
}

type DeploymentRow = Deployment;

function toDto(
  row: DeploymentRow,
  loaded: boolean | null = null,
): DeploymentDto {
  const gate = GateReportSchema.safeParse(row.gateReport);
  return {
    id: row.id,
    organizationId: row.organizationId,
    groupId: row.groupId,
    workspace: row.workspace,
    registeredModel: row.registeredModel,
    version: row.version,
    runId: row.runId,
    status: row.status,
    inferenceEnabled: row.inferenceEnabled,
    loaded: row.status === "ACTIVE" ? loaded : null,
    gate: gate.success ? gate.data : null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function gateJson(report: GateReport, at: Date): Prisma.InputJsonValue {
  return {
    passed: report.passed,
    metrics: report.metrics,
    reasons: report.reasons,
    featureSchemaVersion: report.featureSchemaVersion,
    checkedAt: at.toISOString(),
  } as unknown as Prisma.InputJsonValue;
}

function failedReport(
  at: Date,
  code: string,
  message: string,
): Prisma.InputJsonValue {
  return {
    passed: false,
    metrics: null,
    reasons: [{ code, message, detail: {} }],
    featureSchemaVersion: null,
    checkedAt: at.toISOString(),
  };
}

function interruptedReport(at: Date) {
  return failedReport(at, "CHECK_INTERRUPTED", "The check did not finish");
}

function modelApiDown() {
  return new ApiError(
    503,
    "SERVICE_UNAVAILABLE",
    "The model service is unavailable; try again later",
  );
}

function modelApiFull() {
  return new ApiError(
    409,
    "DEPLOYMENT_LIMIT",
    "The model service cannot load more deployments right now",
  );
}

export function createModelsService(
  prisma: PrismaClient,
  options: ModelsServiceOptions = {},
): ModelsService {
  const config = options.config ?? defaultModelsConfig();
  const now = options.now ?? (() => new Date());
  /** When `models.reconcile_unavailable` was last logged (rate limit). */
  let lastUnavailableWarnAt: number | undefined;
  const { modelApi, registry } = options;

  function requireModelApi() {
    if (!modelApi) {
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "The model service is not configured",
      );
    }
    return modelApi;
  }

  /**
   * CHECKING rows that never completed no longer hold a slot. They are
   * marked FAILED (with an event) and their ids returned so the caller can
   * unload them from the Model API once the transaction committed: the gate
   * may have finished loading after the caller gave up.
   */
  async function sweepStaleChecks(
    transaction: Prisma.TransactionClient,
    where: { organizationId?: string; scopeKey?: string },
    at: Date,
  ): Promise<string[]> {
    const stale = await transaction.deployment.findMany({
      where: {
        ...where,
        status: "CHECKING",
        createdAt: { lt: new Date(at.getTime() - CHECK_STALE_AFTER_MS) },
      },
      orderBy: { createdAt: "asc" },
      take: MAX_SWEEP_BATCH,
    });
    if (stale.length === 0) return [];
    await transaction.deployment.updateMany({
      where: { id: { in: stale.map((row) => row.id) }, status: "CHECKING" },
      data: { status: "FAILED", gateReport: interruptedReport(at) },
    });
    for (const row of stale) {
      await recordEvent(transaction, row, "DEPLOY_FAILED", null);
    }
    return stale.map((row) => row.id);
  }

  /** Best-effort unload: the database is authoritative, reconcile retries. */
  async function unloadQuietly(deploymentId: string, signal?: AbortSignal) {
    if (!modelApi) return;
    await modelApi.unload(deploymentId, { signal }).catch((error: unknown) => {
      // Aborted by shutdown: not a fault, the next reconcile retries.
      if (signal?.aborted) return;
      logEvent("warn", "deployment.unload_failed", {
        feature: "models",
        deploymentId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });
  }

  /**
   * Unloads every deployment the Model API still serves whose row is FAILED,
   * INACTIVE or missing (UUID-shaped ids only; the Model API is private to
   * this app). CHECKING rows are in flight and ACTIVE/QUARANTINED rows own
   * their model, so those are left alone.
   */
  async function unloadOrphans(
    state: ModelApiState,
    signal?: AbortSignal,
  ): Promise<number> {
    const ids = [...state.loaded].filter((id) => UUID_PATTERN.test(id));
    if (ids.length === 0) return 0;
    const rows = await prisma.deployment.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
    });
    const statusById = new Map(rows.map((row) => [row.id, row.status]));
    let unloaded = 0;
    for (const id of ids) {
      if (signal?.aborted) break;
      const status = statusById.get(id);
      if (
        status === undefined ||
        status === "FAILED" ||
        status === "INACTIVE"
      ) {
        await unloadQuietly(id, signal);
        unloaded += 1;
      }
    }
    return unloaded;
  }

  /**
   * Marks a CHECKING row FAILED after the call to the Model API ended without
   * a usable answer, so the attempt keeps counting toward the hourly limit,
   * and unloads whatever the Model API may have loaded meanwhile.
   */
  async function failCheck(
    row: DeploymentRow,
    code: string,
    message: string,
    actorUserId: string | null,
  ) {
    try {
      await prisma.$transaction(async (transaction) => {
        const result = await transaction.deployment.updateMany({
          where: { id: row.id, status: "CHECKING" },
          data: {
            status: "FAILED",
            gateReport: failedReport(now(), code, message),
          },
        });
        if (result.count > 0) {
          await recordEvent(transaction, row, "DEPLOY_FAILED", actorUserId);
        }
      }, TRANSACTION_TIMING);
    } catch (error) {
      // The stale sweep fails the row later.
      logEvent("warn", "deployment.check_failure_unrecorded", {
        feature: "models",
        deploymentId: row.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    await unloadQuietly(row.id);
  }

  /** The deployment of this exact context, row-locked; anything else is 404. */
  async function lockDeployment(
    transaction: Prisma.TransactionClient,
    context: ModelsContext,
    deploymentId: string,
  ) {
    const rows = await transaction.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "Deployment" WHERE id = ${deploymentId} AND "organizationId" = ${context.organizationId} AND "scopeKey" = ${scopeKeyOf(context)} FOR UPDATE`;
    if (rows.length === 0) throw notFound();
    return transaction.deployment.findUniqueOrThrow({
      where: { id: deploymentId },
    });
  }

  async function recordEvent(
    transaction: Prisma.TransactionClient,
    row: DeploymentRow,
    type:
      | "DEPLOYED"
      | "DEPLOY_FAILED"
      | "ACTIVATED"
      | "DEACTIVATED"
      | "REMOVED"
      | "QUARANTINED",
    actorUserId: string | null,
  ) {
    await transaction.deploymentEvent.create({
      data: {
        deploymentId: row.id,
        type,
        actorUserId,
        organizationId: row.organizationId,
        groupId: row.groupId,
      },
    });
  }

  /** Best effort view of the Model API; null when it cannot be reached. */
  async function modelApiState(signal?: AbortSignal) {
    if (!modelApi) return null;
    try {
      return await modelApi.state({ signal });
    } catch (error) {
      if (error instanceof ModelApiUnavailableError) return null;
      throw error;
    }
  }

  /**
   * Re-runs the gate and loads a deployment the Model API lost, then records
   * the result. Returns the outcome; the row is FAILED when the gate now
   * rejects it.
   */
  async function reload(row: DeploymentRow, signal?: AbortSignal) {
    const client = requireModelApi();
    let outcome;
    try {
      outcome = await client.deploy(
        row.id,
        {
          workspace: row.workspace,
          registeredModel: row.registeredModel,
          version: row.version,
        },
        { signal },
      );
    } catch (error) {
      if (error instanceof ModelApiUnavailableError)
        return "unavailable" as const;
      if (error instanceof ModelApiCapacityError) return "unavailable" as const;
      throw error;
    }
    if (outcome.kind === "loaded") return "loaded" as const;
    await mapTransactionTimeout(
      () =>
        prisma.$transaction(async (transaction) => {
          const result = await transaction.deployment.updateMany({
            where: { id: row.id, status: "ACTIVE" },
            data: {
              status: "FAILED",
              inferenceEnabled: false,
              gateReport: gateJson(outcome.report, now()),
            },
          });
          if (result.count > 0) {
            await recordEvent(transaction, row, "DEPLOY_FAILED", null);
          }
        }, TRANSACTION_TIMING),
      "deployment_reload_rejected",
    );
    return "rejected" as const;
  }

  /** Marks an ACTIVE row QUARANTINED (scoring off) and records the event. */
  async function markQuarantined(row: DeploymentRow) {
    const updated = await mapTransactionTimeout(
      () =>
        prisma.$transaction(async (transaction) => {
          const result = await transaction.deployment.updateMany({
            where: { id: row.id, status: "ACTIVE" },
            data: { status: "QUARANTINED", inferenceEnabled: false },
          });
          if (result.count === 0) return null;
          await recordEvent(transaction, row, "QUARANTINED", null);
          return transaction.deployment.findUniqueOrThrow({
            where: { id: row.id },
          });
        }, TRANSACTION_TIMING),
      "deployment_quarantine",
    );
    if (updated) {
      logEvent("warn", "audit.deployment_quarantined", {
        feature: "models",
        action: "DEPLOYMENT_QUARANTINED",
        deploymentId: row.id,
        organizationId: row.organizationId,
      });
    }
    return updated;
  }

  /**
   * Single flight per deployment: concurrent callers (the prediction worker
   * runs several jobs of one deployment at once) share one reload instead of
   * each re-running the gate on the Model API.
   */
  const loading = new Map<
    string,
    Promise<"loaded" | "not_active" | "rejected" | "unavailable">
  >();

  async function loadOnce(deploymentId: string, signal?: AbortSignal) {
    const row = await prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { organization: { select: { mlEnabled: true } } },
    });
    // With the Models section off nothing may be (re)loaded.
    if (!row || row.status !== "ACTIVE" || !row.organization.mlEnabled) {
      return "not_active" as const;
    }
    const state = await modelApiState(signal);
    if (!state) return "unavailable" as const;
    if (state.loaded.has(row.id)) return "loaded" as const;
    if (state.quarantined.has(row.id)) return "rejected" as const;
    return reload(row, signal);
  }

  /**
   * CR-621: ACTIVE deployments with scoring on (and their organization's
   * Models section on) that the Model API does not serve, e.g. after a restart.
   * Each goes through ensureLoaded: single flight per deployment, at most
   * EAGER_RELOAD_CONCURRENCY at once. A failure is logged and changes nothing
   * here; the status rules of reload() (gate rejection) are unchanged.
   */
  // Round-robin memory of reloadLost: the pass in which each deployment was
  // last attempted. A deployment that keeps failing (or was cut off by the
  // MAX_EAGER_RELOADS cap) must not hold the front of the line forever, so
  // never-attempted ids go first and the rest by oldest attempt.
  const lastReloadPass = new Map<string, number>();
  let reloadPass = 0;

  async function reloadLost(
    state: ModelApiState,
    signal?: AbortSignal,
  ): Promise<number> {
    const candidates = await prisma.deployment.findMany({
      where: {
        status: "ACTIVE",
        inferenceEnabled: true,
        organization: { mlEnabled: true },
      },
      select: { id: true },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    });
    const lost = candidates
      .map((row) => row.id)
      .filter((id) => !state.loaded.has(id) && !state.quarantined.has(id));
    // Stable sort: ties (never attempted) keep the updatedAt, id order.
    lost.sort(
      (a, b) => (lastReloadPass.get(a) ?? 0) - (lastReloadPass.get(b) ?? 0),
    );
    lost.length = Math.min(lost.length, MAX_EAGER_RELOADS);
    reloadPass += 1;
    // Forget deployments that are no longer candidates (bounded memory).
    const candidateIds = new Set(candidates.map((row) => row.id));
    for (const id of lastReloadPass.keys()) {
      if (!candidateIds.has(id)) lastReloadPass.delete(id);
    }
    for (const id of lost) lastReloadPass.set(id, reloadPass);
    let reloaded = 0;
    const queue = [...lost];
    const lane = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        if (signal?.aborted) return;
        try {
          const outcome = await service.ensureLoaded(id, { signal });
          if (outcome === "loaded") reloaded += 1;
          else {
            logEvent("warn", "deployment.eager_reload_skipped", {
              feature: "models",
              deploymentId: id,
              outcome,
            });
          }
        } catch (error) {
          logEvent("warn", "deployment.eager_reload_failed", {
            feature: "models",
            deploymentId: id,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(EAGER_RELOAD_CONCURRENCY, lost.length) },
        lane,
      ),
    );
    return reloaded;
  }

  const service: ModelsService = {
    async listModels(userId, context) {
      await runSerializable(
        () =>
          prisma.$transaction(
            (transaction) =>
              authorizeModelsContext(transaction, userId, context, "read"),
            SERIALIZABLE,
          ),
        undefined,
        "models.list",
      );
      if (!registry) {
        throw new ApiError(
          503,
          "SERVICE_UNAVAILABLE",
          "The MLflow registry is not configured",
        );
      }
      const workspace = workspaceOf(context);
      let registered;
      try {
        registered = await registry.listModels(workspace);
      } catch (error) {
        if (error instanceof RegistryUnavailableError) {
          throw new ApiError(
            503,
            "SERVICE_UNAVAILABLE",
            "The MLflow registry is unavailable; try again later",
          );
        }
        throw error;
      }
      return {
        workspace,
        mlflowUrl: config.mlflowPublicUrl
          ? `${config.mlflowPublicUrl}/?context=${encodeURIComponent(workspace)}`
          : null,
        models: registered.models,
        truncated: registered.truncated,
      };
    },

    async listDeployments(userId, context) {
      const scope = {
        organizationId: context.organizationId,
        scopeKey: scopeKeyOf(context),
      };
      // A read only: stale CHECKING rows, quarantines and orphan models are
      // handled by reconcile() on a timer, never by a GET.
      const { rows, activeCount } = await runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await authorizeModelsContext(transaction, userId, context, "read");
            const rows = await transaction.deployment.findMany({
              where: scope,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: LIST_LIMIT,
            });
            // Counted in the database: the list above is capped at 100 rows.
            const activeCount = await transaction.deployment.count({
              where: { ...scope, status: { in: ["ACTIVE", "CHECKING"] } },
            });
            return { rows, activeCount };
          }, SERIALIZABLE),
        undefined,
        "models.deployments.list",
      );

      // Which models the Model API serves (best effort, never an error): a
      // deployment it quarantined or lost is reported as not loaded.
      const state = await modelApiState();
      const items: DeploymentDto[] = rows.map((row) => {
        let loaded: boolean | null = null;
        if (state && row.status === "ACTIVE") {
          loaded = state.loaded.has(row.id) && !state.quarantined.has(row.id);
        }
        return toDto(row, loaded);
      });
      return {
        items,
        limits: {
          activeCount,
          maxActive: config.maxActiveDeployments,
          maxChecksPerHour: config.maxDeployChecksPerHour,
        },
        modelApiAvailable: state !== null || rows.length === 0,
      };
    },

    async deploy(userId, request) {
      const context: ModelsContext = {
        organizationId: request.organizationId,
        groupId: request.groupId,
      };
      const client = requireModelApi();
      const scope = {
        organizationId: context.organizationId,
        scopeKey: scopeKeyOf(context),
      };
      const workspace = workspaceOf(context);

      // Cap, rate limit and the CHECKING row are decided in one serializable
      // transaction, so concurrent requests cannot exceed either limit.
      const { pending, swept } = await runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await authorizeModelsContext(
              transaction,
              userId,
              context,
              "deploy",
            );
            const at = now();
            const swept = await sweepStaleChecks(transaction, scope, at);

            const recent = await transaction.deployment.findMany({
              where: {
                ...scope,
                createdAt: { gt: new Date(at.getTime() - HOUR_MS) },
              },
              select: { createdAt: true },
              orderBy: { createdAt: "asc" },
              take: config.maxDeployChecksPerHour,
            });
            if (recent.length >= config.maxDeployChecksPerHour) {
              const oldest = recent[0]!.createdAt.getTime();
              const retryAfter = Math.max(
                1,
                Math.ceil((oldest + HOUR_MS - at.getTime()) / 1000),
              );
              throw new ApiError(
                429,
                "RATE_LIMITED",
                `At most ${config.maxDeployChecksPerHour} deployment checks per hour are allowed in this scope`,
                undefined,
                { "Retry-After": String(retryAfter) },
              );
            }

            const holding = await transaction.deployment.count({
              where: { ...scope, status: { in: ["CHECKING", "ACTIVE"] } },
            });
            if (holding >= config.maxActiveDeployments) {
              throw new ApiError(
                409,
                "DEPLOYMENT_LIMIT",
                `At most ${config.maxActiveDeployments} active deployments are allowed in this scope; remove one first`,
              );
            }

            const live = await transaction.deployment.findFirst({
              where: {
                ...scope,
                registeredModel: request.registeredModel,
                version: request.version,
                status: { in: ["CHECKING", "ACTIVE", "QUARANTINED"] },
              },
              select: { id: true, status: true },
            });
            if (live) {
              // A retry of a request whose answer never arrived (for example
              // a proxy timeout while the gate ran) lands here: the conflict
              // carries the current state, so the client polls it instead of
              // guessing.
              throw new ApiError(
                409,
                "CONFLICT",
                "This model version is already deployed in this scope",
                { deploymentId: live.id, status: live.status },
              );
            }
            const pending = await transaction.deployment.create({
              data: {
                organizationId: context.organizationId,
                groupId: context.groupId,
                scopeKey: scope.scopeKey,
                workspace,
                registeredModel: request.registeredModel,
                version: request.version,
                status: "CHECKING",
                createdByUserId: userId,
              },
            });
            return { pending, swept };
          }, SERIALIZABLE),
        undefined,
        "models.deploy",
      );
      for (const id of swept) await unloadQuietly(id);

      logEvent("info", "audit.deployment_requested", {
        feature: "models",
        action: "DEPLOYMENT_REQUESTED",
        deploymentId: pending.id,
        organizationId: pending.organizationId,
        ...(pending.groupId ? { groupId: pending.groupId } : {}),
        actorUserId: userId,
      });

      let outcome;
      try {
        outcome = await client.deploy(pending.id, {
          workspace,
          registeredModel: request.registeredModel,
          version: request.version,
        });
      } catch (error) {
        if (
          error instanceof ModelApiUnavailableError &&
          error.reason !== "connection"
        ) {
          // The Model API answered (or may still be working): the gate may
          // have run, so the attempt stays on the books as FAILED and counts
          // toward the hourly limit; anything it loaded is unloaded.
          await failCheck(
            pending,
            error.reason === "timeout" ? "CHECK_TIMEOUT" : "MODEL_API_ERROR",
            error.reason === "timeout"
              ? "The model service did not answer in time"
              : "The model service answered with an error",
            userId,
          );
          throw modelApiDown();
        }
        // Nothing ran at the gate (no connection, or no capacity): the
        // attempt leaves no trace and costs no rate-limit budget.
        await prisma.deployment.deleteMany({
          where: { id: pending.id, status: "CHECKING" },
        });
        if (error instanceof ModelApiUnavailableError) throw modelApiDown();
        if (error instanceof ModelApiCapacityError) throw modelApiFull();
        throw error;
      }

      const at = now();
      const loadedNow = outcome.kind === "loaded";
      let finished;
      try {
        finished = await mapTransactionTimeout(
          () =>
            prisma.$transaction(async (transaction) => {
              const passed = outcome.kind === "loaded";
              const result = await transaction.deployment.updateMany({
                where: { id: pending.id, status: "CHECKING" },
                data: {
                  status: passed ? "ACTIVE" : "FAILED",
                  runId: outcome.report.runId,
                  gateReport: gateJson(outcome.report, at),
                },
              });
              if (result.count === 0) return null;
              const row = await transaction.deployment.findUniqueOrThrow({
                where: { id: pending.id },
              });
              await recordEvent(
                transaction,
                row,
                passed ? "DEPLOYED" : "DEPLOY_FAILED",
                userId,
              );
              return row;
            }, TRANSACTION_TIMING),
          "deployment_check_finish",
        );
      } catch (error) {
        // The row stays CHECKING (the stale sweep fails it); do not leave the
        // model loaded behind it.
        if (loadedNow) await unloadQuietly(pending.id);
        throw error;
      }
      if (!finished) {
        // The stale-check sweep gave up on this row while the gate ran.
        if (outcome.kind === "loaded") {
          await client.unload(pending.id).catch(() => undefined);
        }
        throw new ApiError(
          409,
          "CONFLICT",
          "The deployment check took too long and was discarded; try again",
        );
      }
      logEvent("info", "audit.deployment_checked", {
        feature: "models",
        action:
          outcome.kind === "loaded"
            ? "DEPLOYMENT_DEPLOYED"
            : "DEPLOYMENT_REJECTED",
        deploymentId: finished.id,
        organizationId: finished.organizationId,
        ...(finished.groupId ? { groupId: finished.groupId } : {}),
        actorUserId: userId,
      });
      return toDto(finished, outcome.kind === "loaded" ? true : null);
    },

    async setInference(userId, context, deploymentId, enabled) {
      // First look, row-locked: authorization and the preconditions.
      const current = await runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await authorizeModelsContext(
              transaction,
              userId,
              context,
              "deploy",
            );
            return lockDeployment(transaction, context, deploymentId);
          }, SERIALIZABLE),
        undefined,
        "models.inference.check",
      );
      if (current.inferenceEnabled === enabled) {
        return { deployment: toDto(current), changed: false };
      }
      if (enabled) {
        if (current.status !== "ACTIVE") {
          throw new ApiError(
            409,
            "CONFLICT",
            "Only an active deployment can score new invoices",
          );
        }
        // Turning scoring on needs the model loaded; a Model API restart
        // forgets it, so this is where it is reloaded.
        const state = await modelApiState();
        if (!state) throw modelApiDown();
        if (state.quarantined.has(current.id)) {
          await mapTransactionTimeout(
            () =>
              prisma.$transaction(async (transaction) => {
                const result = await transaction.deployment.updateMany({
                  where: { id: current.id, status: "ACTIVE" },
                  data: { status: "QUARANTINED", inferenceEnabled: false },
                });
                if (result.count > 0) {
                  await recordEvent(transaction, current, "QUARANTINED", null);
                }
              }, TRANSACTION_TIMING),
            "deployment_quarantine",
          );
          throw new ApiError(
            409,
            "CONFLICT",
            "The model was quarantined after repeated inference failures; remove it and deploy it again",
          );
        }
        if (!state.loaded.has(current.id)) {
          const result = await reload(current);
          if (result === "unavailable") throw modelApiDown();
          if (result === "rejected") {
            throw new ApiError(
              409,
              "CONFLICT",
              "The model no longer passes the validation gate",
            );
          }
        }
      }
      const updated = await runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            const row = await lockDeployment(
              transaction,
              context,
              deploymentId,
            );
            if (enabled && row.status !== "ACTIVE") {
              throw new ApiError(
                409,
                "CONFLICT",
                "Only an active deployment can score new invoices",
              );
            }
            if (row.inferenceEnabled === enabled)
              return { row, changed: false };
            const saved = await transaction.deployment.update({
              where: { id: row.id },
              data: { inferenceEnabled: enabled },
            });
            await recordEvent(
              transaction,
              saved,
              enabled ? "ACTIVATED" : "DEACTIVATED",
              userId,
            );
            return { row: saved, changed: true };
          }, SERIALIZABLE),
        undefined,
        "models.inference.update",
      );
      return {
        deployment: toDto(updated.row, enabled ? true : null),
        changed: updated.changed,
      };
    },

    async remove(userId, context, deploymentId) {
      const result = await runSerializable(
        () =>
          prisma.$transaction(async (transaction) => {
            await authorizeModelsContext(
              transaction,
              userId,
              context,
              "deploy",
            );
            const row = await lockDeployment(
              transaction,
              context,
              deploymentId,
            );
            if (row.status === "CHECKING") {
              throw new ApiError(
                409,
                "CONFLICT",
                "The deployment check is still running",
              );
            }
            // Already off the books (or a failed attempt, kept as history).
            if (row.status === "INACTIVE" || row.status === "FAILED") {
              return { row, changed: false };
            }
            const saved = await transaction.deployment.update({
              where: { id: row.id },
              data: { status: "INACTIVE", inferenceEnabled: false },
            });
            await recordEvent(transaction, saved, "REMOVED", userId);
            return { row: saved, changed: true };
          }, SERIALIZABLE),
        undefined,
        "models.remove",
      );
      if (result.changed && modelApi) {
        // The database is authoritative: a model that could not be unloaded
        // now is unloaded the next time the list reconciles.
        await modelApi.unload(deploymentId).catch((error: unknown) => {
          logEvent("warn", "deployment.unload_failed", {
            feature: "models",
            deploymentId,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        });
      }
      return { deployment: toDto(result.row), changed: result.changed };
    },

    ensureLoaded(deploymentId, callOptions = {}) {
      const inflight = loading.get(deploymentId);
      if (inflight) return inflight;
      const started = loadOnce(deploymentId, callOptions.signal).finally(() => {
        loading.delete(deploymentId);
      });
      loading.set(deploymentId, started);
      return started;
    },

    async reconcile(callOptions = {}) {
      const { signal } = callOptions;
      const at = now();
      // CHECKING rows nobody completed (the process died mid-gate) stop
      // holding a slot; whatever they loaded is unloaded below.
      const swept = await runSerializable(
        () =>
          prisma.$transaction(
            (transaction) => sweepStaleChecks(transaction, {}, at),
            SERIALIZABLE,
          ),
        undefined,
        "models.reconcile.sweep",
      );
      let unloaded = 0;
      for (const id of swept) {
        if (signal?.aborted) break;
        await unloadQuietly(id, signal);
        unloaded += 1;
      }
      const state = await modelApiState(signal);
      if (!state) {
        // A shutdown abort is not a fault. Otherwise the pass runs on a
        // timer, so the warning is rate limited to one per interval.
        if (
          !signal?.aborted &&
          (lastUnavailableWarnAt === undefined ||
            at.getTime() - lastUnavailableWarnAt >=
              RECONCILE_UNAVAILABLE_WARN_INTERVAL_MS)
        ) {
          lastUnavailableWarnAt = at.getTime();
          logEvent("warn", "models.reconcile_unavailable", {
            feature: "models",
            sweptCount: swept.length,
          });
        }
        return {
          swept: swept.length,
          quarantined: 0,
          unloaded,
          reloaded: 0,
          modelApiAvailable: false,
        };
      }

      let quarantined = 0;
      const quarantinedIds = [...state.quarantined].filter((id) =>
        UUID_PATTERN.test(id),
      );
      if (quarantinedIds.length > 0) {
        const rows = await prisma.deployment.findMany({
          where: { id: { in: quarantinedIds }, status: "ACTIVE" },
        });
        for (const row of rows) {
          if (signal?.aborted) break;
          if (await markQuarantined(row)) quarantined += 1;
        }
      }

      const before = unloaded;
      unloaded += await unloadOrphans(state, signal);
      // The Models section of these organizations is off: nothing of theirs
      // stays loaded. Rows keep their status, so switching the section back
      // on makes the next prediction or inference toggle reload the model.
      const loadedIds = [...state.loaded].filter((id) => UUID_PATTERN.test(id));
      if (loadedIds.length > 0) {
        const disabled = await prisma.deployment.findMany({
          where: {
            id: { in: loadedIds },
            status: { in: [...OWNED_STATUSES] },
            organization: { mlEnabled: false },
          },
          select: { id: true },
        });
        for (const { id } of disabled) {
          if (signal?.aborted) break;
          await unloadQuietly(id, signal);
          unloaded += 1;
        }
      }
      const reloaded = signal?.aborted ? 0 : await reloadLost(state, signal);
      if (swept.length + quarantined + (unloaded - before) + reloaded > 0) {
        logEvent("info", "models.reconciled", {
          feature: "models",
          sweptCount: swept.length,
          quarantinedCount: quarantined,
          unloadedCount: unloaded,
          reloadedCount: reloaded,
        });
      }
      return {
        swept: swept.length,
        quarantined,
        unloaded,
        reloaded,
        modelApiAvailable: true,
      };
    },
  };
  return service;
}
