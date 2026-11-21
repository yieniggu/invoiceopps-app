import type { PrismaClient } from "../../generated/prisma/client.js";
import { logEvent } from "../../http/logging.js";
import {
  ModelApiUnavailableError,
  type ModelApiClient,
  type PredictOutcome,
  type PredictRequest,
} from "../models/model-api-client.js";
import type { ModelsService } from "../models/services.js";
import { supplierKey } from "../../supplier-key.js";
import {
  DEFAULT_PREDICTION_WORKER_CONFIG,
  type PredictionWorkerConfig,
} from "./config.js";

/**
 * At most this many prior invoices of the supplier travel with a prediction
 * (the most recent ones). The Model API derives its supplier features from
 * them, so a supplier with a longer history is summarized by its latest
 * MAX_PRIOR_INVOICES invoices. This equals the Model API's own maximum
 * (invoiceops-model-api `max_prior_invoices`, default 5000; more is a 422), so
 * features match training for every supplier the Model API accepts.
 */
export const MAX_PRIOR_INVOICES = 5000;

/**
 * Request body budget. The Model API answers 413 above its own 4 MiB body
 * limit (`max_body_bytes`), so the worker stays under it with a margin. 5000
 * priors are ~1 MB (at most ~4 MB with 200-character four-byte names), so this
 * guard only trims (oldest priors first) in pathological cases. The other
 * Model API limits cannot be exceeded either: one prediction carries at most
 * MAX_PRIOR_INVOICES priors (the 20000 total is per batch request), and
 * amountPesos is capped at 2^31-1 by the invoice schema (limit 10^13).
 */
export const MAX_PREDICT_BODY_BYTES = 3.5 * 1024 * 1024;

export interface PredictionWorker {
  /** Starts the background loop (idempotent). */
  start(): void;
  /** Stops polling and waits for the jobs in flight; unstarted claims are released. */
  stop(): Promise<void>;
  /** One poll: claims due jobs and processes them. Returns how many were claimed. */
  runOnce(): Promise<number>;
}

export interface PredictionWorkerOptions {
  config?: PredictionWorkerConfig;
  modelApi: ModelApiClient;
  /** ensureLoaded is the DEPLOYMENT_NOT_LOADED recovery path (MLOPS-05). */
  models: Pick<ModelsService, "ensureLoaded">;
  now?: () => Date;
  random?: () => number;
}

interface Claim {
  id: string;
  invoiceId: string;
  deploymentId: string;
  /** Attempts including this one. */
  attempts: number;
  /** Retries caused by an unavailable Model API so far (no attempt consumed). */
  unavailableRetries: number;
  createdAt: Date;
}

/**
 * Failure codes that say "the Model API cannot be reached or served right
 * now", not "this job is wrong": a retry for one of them consumes no attempt
 * (the outage is bounded by the job's maximum age instead). MODEL_API_ERROR,
 * DEPLOYMENT_NOT_LOADED and WORKER_ERROR still count: the service answered or
 * the worker failed, and an endlessly failing job must end.
 */
export const UNAVAILABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "MODEL_API_UNREACHABLE",
  "MODEL_API_TIMEOUT",
  "MODEL_API_UNAVAILABLE",
  "INFERENCE_UNAVAILABLE",
  "MODEL_API_AUTH",
]);

/**
 * Capped exponential backoff with jitter for the `retries`-th (1-based) retry:
 * retryBase * 2^(retries-1), never above retryMax, then 50-100% of that.
 */
export function backoffDelayMs(
  retries: number,
  config: Pick<PredictionWorkerConfig, "retryBaseMs" | "retryMaxMs">,
  random: () => number,
) {
  const raw = Math.min(
    config.retryMaxMs,
    config.retryBaseMs * 2 ** Math.min(30, Math.max(0, retries - 1)),
  );
  return Math.round(raw * (0.5 + random() * 0.5));
}

type Verdict =
  | {
      kind: "succeeded";
      prediction: Extract<PredictOutcome, { kind: "ok" }>["prediction"];
    }
  | { kind: "skipped"; code: string }
  | { kind: "retry"; code: string }
  | { kind: "failed"; code: string }
  /** Shutdown interrupted the job: give the claim back, attempt not consumed. */
  | { kind: "aborted" };

/** Thrown inside decide() when the shutdown signal fired. */
class ShutdownAbort extends Error {}

/** Timestamps are stored as UTC `timestamp(3)`; cast an ISO string explicitly. */
const iso = (date: Date) => date.toISOString();

/** Raw fields of the evaluated invoice the payload is built from. */
export interface PredictInvoiceSource {
  supplierName: string;
  amountPesos: number;
  issuedOn: Date;
  dueOn: Date;
  createdAt: Date;
}

/**
 * Payload for the Model API: raw fields only (features are computed in
 * Python, `invoiceops_ml.contract.compute_features`). Prior statuses are the
 * CURRENT ones: the worker scores right after creation, so they equal the
 * statuses as of the invoice's createdAt; `decidedAt` is therefore never sent.
 */
export function buildPredictRequest(
  invoice: PredictInvoiceSource,
  priors: Array<{
    supplierName: string;
    amountPesos: number;
    createdAt: Date;
    businessStatus: string;
  }>,
): PredictRequest {
  return {
    invoice: {
      supplierName: invoice.supplierName,
      amountPesos: invoice.amountPesos,
      issuedOn: invoice.issuedOn.toISOString().slice(0, 10),
      dueOn: invoice.dueOn.toISOString().slice(0, 10),
      createdAt: invoice.createdAt.toISOString(),
      // The invoice's own businessStatus is the label being predicted: it
      // is never sent.
    },
    priorInvoices: priors.map((prior) => ({
      supplierName: prior.supplierName,
      amountPesos: prior.amountPesos,
      createdAt: prior.createdAt.toISOString(),
      businessStatus: prior.businessStatus,
    })),
  };
}

/** One `prediction.unkeyed_priors_capped` warning per scope per this long. */
export const UNKEYED_PRIORS_WARN_INTERVAL_MS = 10 * 60_000;
const MAX_TRACKED_SCOPES = 1000;
const unkeyedWarnedAt = new Map<string, number>();

/** Forgets the rate-limit memory of the capped-priors warning (tests). */
export function resetUnkeyedPriorsWarnings() {
  unkeyedWarnedAt.clear();
}

/**
 * Every prediction of a capped scope hits the cap until the backfill ends, so
 * the warning is limited to once per (organization, scope) per interval; the
 * first occurrence of each scope is always logged.
 */
function warnUnkeyedPriorsCapped(
  invoice: { id: string; organizationId: string; scopeKey: string },
  nowMs: number,
) {
  const key = `${invoice.organizationId}:${invoice.scopeKey}`;
  const last = unkeyedWarnedAt.get(key);
  if (last !== undefined && nowMs - last < UNKEYED_PRIORS_WARN_INTERVAL_MS) {
    return;
  }
  if (unkeyedWarnedAt.size >= MAX_TRACKED_SCOPES) {
    for (const [tracked, at] of unkeyedWarnedAt) {
      if (nowMs - at >= UNKEYED_PRIORS_WARN_INTERVAL_MS) {
        unkeyedWarnedAt.delete(tracked);
      }
    }
    // Still full of recent scopes: drop the oldest entry (insertion order).
    if (unkeyedWarnedAt.size >= MAX_TRACKED_SCOPES) {
      const oldest = unkeyedWarnedAt.keys().next().value;
      if (oldest !== undefined) unkeyedWarnedAt.delete(oldest);
    }
  }
  unkeyedWarnedAt.delete(key);
  unkeyedWarnedAt.set(key, nowMs);
  logEvent("warn", "prediction.unkeyed_priors_capped", {
    feature: "predictions",
    invoiceId: invoice.id,
    organizationId: invoice.organizationId,
    threshold: MAX_PRIOR_INVOICES,
  });
}

/**
 * Same supplier key, same scope, created earlier, not deleted: an equality
 * lookup on Invoice(organizationId, scopeKey, supplierKey, createdAt DESC).
 * Rows still without a key (written by an older release during a rolling
 * deploy, or not backfilled yet) are matched by computing their key here
 * (partial index on supplierKey IS NULL), so they never skew the features.
 * Limit of that fallback: it reads only the newest MAX_PRIOR_INVOICES unkeyed
 * rows of the scope (any supplier). When that cap is hit, older unkeyed
 * invoices of this supplier can be missing, so the priors may be incomplete
 * until the supplierKey backfill finishes; the
 * `prediction.unkeyed_priors_capped` warning marks such lookups (rate
 * limited to one per scope per UNKEYED_PRIORS_WARN_INTERVAL_MS).
 * The Model API filters again with the identical Python supplier_key.
 */
export async function loadPriorInvoices(
  prisma: Pick<PrismaClient, "invoice">,
  invoice: {
    id: string;
    organizationId: string;
    scopeKey: string;
    supplierName: string;
    createdAt: Date;
  },
  nowMs: () => number = Date.now,
) {
  const key = supplierKey(invoice.supplierName);
  const common = {
    organizationId: invoice.organizationId,
    scopeKey: invoice.scopeKey,
    deletedAt: null,
    createdAt: { lt: invoice.createdAt },
    id: { not: invoice.id },
  };
  const select = {
    id: true,
    supplierName: true,
    amountPesos: true,
    createdAt: true,
    businessStatus: true,
  } as const;
  const orderBy = [{ createdAt: "desc" }, { id: "desc" }] as const;
  const [keyed, unkeyed] = await Promise.all([
    prisma.invoice.findMany({
      where: { ...common, supplierKey: key },
      select,
      orderBy: [...orderBy],
      take: MAX_PRIOR_INVOICES,
    }),
    prisma.invoice.findMany({
      where: { ...common, supplierKey: null },
      select,
      orderBy: [...orderBy],
      take: MAX_PRIOR_INVOICES,
    }),
  ]);
  if (unkeyed.length >= MAX_PRIOR_INVOICES) {
    // The fallback reads the newest MAX_PRIOR_INVOICES rows of the scope that
    // still lack a supplierKey (any supplier) and filters them in memory, so
    // older rows of this supplier may be missing from the priors until the
    // backfill finishes. Alert on this event; see the README.
    warnUnkeyedPriorsCapped(invoice, nowMs());
  }
  const matchingUnkeyed = unkeyed.filter(
    (row) => supplierKey(row.supplierName) === key,
  );
  if (matchingUnkeyed.length === 0) return keyed;
  return [...keyed, ...matchingUnkeyed]
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )
    .slice(0, MAX_PRIOR_INVOICES);
}

export function createPredictionWorker(
  prisma: PrismaClient,
  options: PredictionWorkerOptions,
): PredictionWorker {
  const config = options.config ?? DEFAULT_PREDICTION_WORKER_CONFIG;
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const { modelApi, models } = options;

  let stopped = true;
  // Aborted by stop(): cancels in-flight Model API calls so shutdown is quick.
  let shutdown = new AbortController();
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  /**
   * Jobs claimed per poll: never more than the worker runs at the same time.
   * A claim leases the job and counts an attempt, so a job claimed behind a
   * busy lane would burn an attempt (and could outlive its lease) without
   * having started. Every claimed job starts immediately.
   */
  const claimLimit = Math.min(config.batchSize, config.concurrency);

  /**
   * Claims due PENDING jobs. One statement: the sub-select locks the rows with
   * FOR UPDATE SKIP LOCKED, so concurrent workers get disjoint jobs, and the
   * update leases them (nextAttemptAt moves ahead) and counts the attempt. A
   * job whose worker died is re-claimed only after the lease; one that ran
   * out of attempts that way, or outlived its maximum age, is closed as FAILED
   * first.
   */
  async function claim(): Promise<Claim[]> {
    const at = iso(now());
    await prisma.$executeRaw`
      UPDATE "InvoicePrediction"
      SET "status" = 'FAILED', "lastErrorCode" = 'ATTEMPTS_EXHAUSTED',
          "updatedAt" = ${at}::timestamp
      WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${at}::timestamp
        AND "attempts" >= ${config.maxAttempts}`;
    const oldestAllowed = iso(new Date(now().getTime() - config.maxJobAgeMs));
    await prisma.$executeRaw`
      UPDATE "InvoicePrediction"
      SET "status" = 'FAILED', "lastErrorCode" = 'JOB_EXPIRED',
          "updatedAt" = ${at}::timestamp
      WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${at}::timestamp
        AND "createdAt" <= ${oldestAllowed}::timestamp`;
    const lease = iso(new Date(now().getTime() + config.leaseMs));
    return prisma.$queryRaw<Claim[]>`
      UPDATE "InvoicePrediction"
      SET "attempts" = "attempts" + 1, "nextAttemptAt" = ${lease}::timestamp,
          "updatedAt" = ${at}::timestamp
      WHERE "id" IN (
        SELECT "id" FROM "InvoicePrediction"
        WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${at}::timestamp
          AND "attempts" < ${config.maxAttempts}
        ORDER BY "nextAttemptAt" ASC, "id" ASC
        LIMIT ${claimLimit}
        FOR UPDATE SKIP LOCKED)
      RETURNING "id", "invoiceId", "deploymentId", "attempts",
                "unavailableRetries", "createdAt"`;
  }

  /** Writes the outcome only while this claim still owns the job. */
  async function settle(
    job: Claim,
    data: Parameters<
      PrismaClient["invoicePrediction"]["updateMany"]
    >[0]["data"],
  ) {
    await prisma.invoicePrediction.updateMany({
      where: { id: job.id, status: "PENDING", attempts: job.attempts },
      data,
    });
  }

  async function retryOrFail(job: Claim, code: string) {
    const fail = async (failureCode: string) => {
      await settle(job, { status: "FAILED", lastErrorCode: failureCode });
      logEvent("warn", "prediction.failed", {
        feature: "predictions",
        predictionId: job.id,
        code: failureCode,
        attempt: job.attempts,
      });
    };
    if (now().getTime() - job.createdAt.getTime() >= config.maxJobAgeMs) {
      await fail("JOB_EXPIRED");
      return;
    }
    if (UNAVAILABLE_ERROR_CODES.has(code)) {
      // The Model API is not available: wait (capped backoff) without
      // consuming the attempt this claim counted.
      const retries = job.unavailableRetries + 1;
      await settle(job, {
        attempts: job.attempts - 1,
        unavailableRetries: retries,
        lastErrorCode: code,
        nextAttemptAt: new Date(
          now().getTime() + backoffDelayMs(retries, config, random),
        ),
      });
      logEvent("info", "prediction.retry_scheduled", {
        feature: "predictions",
        predictionId: job.id,
        code,
        attempt: job.attempts,
      });
      return;
    }
    if (job.attempts >= config.maxAttempts) {
      await fail(code);
      return;
    }
    await settle(job, {
      lastErrorCode: code,
      nextAttemptAt: new Date(
        now().getTime() + backoffDelayMs(job.attempts, config, random),
      ),
    });
    logEvent("info", "prediction.retry_scheduled", {
      feature: "predictions",
      predictionId: job.id,
      code,
      attempt: job.attempts,
    });
  }

  async function decide(job: Claim): Promise<Verdict> {
    const row = await prisma.invoicePrediction.findUnique({
      where: { id: job.id },
      include: {
        invoice: { include: { organization: { select: { mlEnabled: true } } } },
        deployment: { select: { status: true, inferenceEnabled: true } },
      },
    });
    if (!row) return { kind: "skipped", code: "JOB_MISSING" };
    // Re-checked at processing time, not trusted from enqueue time.
    if (row.invoice.deletedAt) {
      return { kind: "skipped", code: "INVOICE_DELETED" };
    }
    if (!row.invoice.organization.mlEnabled) {
      return { kind: "skipped", code: "ML_DISABLED" };
    }
    if (
      row.deployment.status !== "ACTIVE" ||
      !row.deployment.inferenceEnabled
    ) {
      return { kind: "skipped", code: "DEPLOYMENT_INACTIVE" };
    }

    const priors = await loadPriorInvoices(prisma, row.invoice);
    const request = buildPredictRequest(row.invoice, priors);

    // Oldest priors (the tail) go first if the body would exceed the budget.
    let bodyBytes = Buffer.byteLength(JSON.stringify(request));
    while (
      bodyBytes > MAX_PREDICT_BODY_BYTES &&
      request.priorInvoices.length > 0
    ) {
      const dropped = request.priorInvoices.splice(
        Math.max(0, request.priorInvoices.length - 100),
      );
      bodyBytes -= Buffer.byteLength(JSON.stringify(dropped));
    }

    const signal = shutdown.signal;
    const call = async (): Promise<PredictOutcome> => {
      try {
        return await modelApi.predict(row.deploymentId, request, { signal });
      } catch (error) {
        if (signal.aborted) throw new ShutdownAbort();
        if (error instanceof ModelApiUnavailableError) {
          return {
            kind: "error",
            retryable: true,
            code:
              error.reason === "timeout"
                ? "MODEL_API_TIMEOUT"
                : error.reason === "connection"
                  ? "MODEL_API_UNREACHABLE"
                  : "MODEL_API_ERROR",
          };
        }
        throw error;
      }
    };

    let outcome = await call();
    if (outcome.kind === "not_loaded") {
      // The Model API lost the model (restart): reload it, then try once more.
      // ensureLoaded (up to 120 s) has no signal: stop waiting on shutdown.
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new ShutdownAbort());
        signal.addEventListener("abort", () => reject(new ShutdownAbort()), {
          once: true,
        });
      });
      const loaded = await Promise.race([
        models.ensureLoaded(row.deploymentId),
        aborted,
      ]);
      if (loaded === "not_active") {
        return { kind: "skipped", code: "DEPLOYMENT_INACTIVE" };
      }
      if (loaded === "rejected") {
        return { kind: "skipped", code: "DEPLOYMENT_REJECTED" };
      }
      if (loaded === "unavailable") {
        return { kind: "retry", code: "MODEL_API_UNAVAILABLE" };
      }
      outcome = await call();
      if (outcome.kind === "not_loaded") {
        return { kind: "retry", code: "DEPLOYMENT_NOT_LOADED" };
      }
    }
    if (outcome.kind === "ok") {
      return { kind: "succeeded", prediction: outcome.prediction };
    }
    return outcome.retryable
      ? { kind: "retry", code: outcome.code }
      : { kind: "failed", code: outcome.code };
  }

  async function process(job: Claim) {
    let verdict: Verdict;
    try {
      verdict = await decide(job);
    } catch (error) {
      if (error instanceof ShutdownAbort || shutdown.signal.aborted) {
        verdict = { kind: "aborted" };
      } else {
        logEvent("error", "prediction.worker_error", {
          feature: "predictions",
          predictionId: job.id,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        verdict = { kind: "retry", code: "WORKER_ERROR" };
      }
    }
    switch (verdict.kind) {
      case "aborted":
        await release(job);
        return;
      case "succeeded":
        await settle(job, {
          status: "SUCCEEDED",
          probability: verdict.prediction.probability,
          modelVersion: verdict.prediction.modelVersion,
          runId: verdict.prediction.runId,
          featureSchemaVersion: verdict.prediction.featureSchemaVersion,
          lastErrorCode: null,
        });
        return;
      case "skipped":
        await settle(job, { status: "SKIPPED", lastErrorCode: verdict.code });
        return;
      case "failed":
        await settle(job, { status: "FAILED", lastErrorCode: verdict.code });
        return;
      case "retry":
        await retryOrFail(job, verdict.code);
    }
  }

  /** Gives an unstarted claim back, undoing its attempt (graceful shutdown). */
  async function release(job: Claim) {
    await prisma.invoicePrediction.updateMany({
      where: { id: job.id, status: "PENDING", attempts: job.attempts },
      data: { attempts: job.attempts - 1, nextAttemptAt: now() },
    });
  }

  async function runOnce() {
    const claimed = await claim();
    const queue = [...claimed];
    const lane = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        if (stopped) {
          await release(job).catch(() => undefined);
          continue;
        }
        await process(job).catch((error: unknown) => {
          // The lease expires and the job is claimed again.
          logEvent("error", "prediction.settle_failed", {
            feature: "predictions",
            predictionId: job.id,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        });
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(config.concurrency, claimed.length) },
        lane,
      ),
    );
    return claimed.length;
  }

  function pause(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async function run() {
    while (!stopped) {
      let claimed = 0;
      try {
        // `stopped` is false while runOnce executes except during shutdown.
        claimed = await runOnce();
      } catch (error) {
        logEvent("error", "prediction.poll_failed", {
          feature: "predictions",
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
      if (!stopped && claimed < claimLimit) {
        await pause(config.pollIntervalMs);
      }
    }
  }

  return {
    runOnce: async () => {
      // A manual poll processes its claims regardless of the loop's state.
      const wasStopped = stopped;
      if (wasStopped) shutdown = new AbortController();
      stopped = false;
      try {
        return await runOnce();
      } finally {
        stopped = wasStopped;
      }
    },
    start() {
      if (!stopped) return;
      stopped = false;
      shutdown = new AbortController();
      loop = run();
    },
    async stop() {
      stopped = true;
      // In-flight Model API calls are cancelled and their claims released
      // (attempt not consumed) instead of waiting for the 15 s predict timeout.
      shutdown.abort();
      wake?.();
      await loop;
      loop = undefined;
    },
  };
}
