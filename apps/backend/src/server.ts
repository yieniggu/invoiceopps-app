import { createApp } from "./app.js";
import { createAuthService } from "./auth.js";
import { createBackgroundTask } from "./background-task.js";
import {
  authRateLimitConfigFromEnv,
  createAuthRateLimiterFromConfig,
  disabledAuthRateLimiter,
} from "./auth-rate-limit.js";
import { createBusinessPolicyService } from "./business-policies.js";
import { createDatabase } from "./database.js";
import { mlflowCallbackUrlFromEnv } from "./features/mlflow-sso/config.js";
import { internalServiceSecretFromEnv } from "./features/api-tokens/introspection.js";
import { createGroupCatalogService } from "./features/groups/services.js";
import {
  modelsConfigFromEnv,
  positiveInteger,
} from "./features/models/config.js";
import {
  predictionMonitorConfigFromEnv,
  predictionWorkerConfigFromEnv,
  predictionWorkerEnabled,
} from "./features/predictions/config.js";
import { reportPredictionQueue } from "./features/predictions/metrics.js";
import { createPredictionWorker } from "./features/predictions/worker.js";
import { createModelApiClient } from "./features/models/model-api-client.js";
import { createModelRegistryClient } from "./features/models/registry-client.js";
import { createModelsService } from "./features/models/services.js";
import { publicOriginFromEnv } from "./http/public-origin.js";
import { logEvent } from "./http/logging.js";
import { assertDistinctServiceSecrets } from "./service-secret.js";
import { runStartupSupplierKeyBackfill } from "./supplier-key-backfill.js";
import { trustProxyHopsFromEnv } from "./http/trust-proxy.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be configured");
}
// Local default avoids 3000; containers set PORT explicitly.
const port = Number(process.env.PORT || 4380);
// Loopback by default: a local run is never reachable from the network.
// Containers set HOST=0.0.0.0 so the published port reaches the process.
const host = process.env.HOST || "127.0.0.1";
const database = createDatabase(databaseUrl);
const authRateLimitConfig = authRateLimitConfigFromEnv({
  AUTH_RATE_LIMIT_DISABLED: process.env.AUTH_RATE_LIMIT_DISABLED,
  AUTH_RATE_LIMIT_MAX_ATTEMPTS: process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS,
  AUTH_RATE_LIMIT_WINDOW_MS: process.env.AUTH_RATE_LIMIT_WINDOW_MS,
  NODE_ENV: process.env.NODE_ENV,
});
if (authRateLimitConfig.disabled) {
  console.warn(
    "Auth rate limiting is DISABLED (AUTH_RATE_LIMIT_DISABLED=true)",
  );
}
// Behind a reverse proxy request.ip is the proxy; set the hop count so the
// login limiter keys on the real client (see README, AUTH_TRUST_PROXY_HOPS).
const trustProxyHops = trustProxyHopsFromEnv(process.env.AUTH_TRUST_PROXY_HOPS);
// Browser-facing origin used by the cookie-write CSRF check (see README).
const publicOrigin = publicOriginFromEnv(process.env.PUBLIC_ORIGIN);
// Service credential of the private /internal routes; unset fails closed.
// A set-but-malformed secret refuses to start (see internalServiceSecretFromEnv).
const internalServiceSecret = internalServiceSecretFromEnv(
  process.env.INTERNAL_INTROSPECTION_SECRET,
);
// Only redirect_uri accepted by GET /api/v1/mlflow/authorize; malformed refuses to start.
const mlflowCallbackUrl = mlflowCallbackUrlFromEnv({
  MLFLOW_PUBLIC_URL: process.env.MLFLOW_PUBLIC_URL,
  NODE_ENV: process.env.NODE_ENV,
});
if (!internalServiceSecret) {
  console.warn(
    "INTERNAL_INTROSPECTION_SECRET is not set: /internal/api-tokens/introspect refuses every request",
  );
}
// MLOPS-05 (Models section). Unset keeps the feature unconfigured (its
// endpoints answer 503); a half-set or malformed value refuses to start.
const modelsConfig = modelsConfigFromEnv({
  MODEL_API_URL: process.env.MODEL_API_URL,
  MODEL_API_SERVICE_TOKEN: process.env.MODEL_API_SERVICE_TOKEN,
  MLFLOW_GATEWAY_INTERNAL_URL: process.env.MLFLOW_GATEWAY_INTERNAL_URL,
  GATEWAY_SERVICE_READ_TOKEN: process.env.GATEWAY_SERVICE_READ_TOKEN,
  MLFLOW_PUBLIC_URL: process.env.MLFLOW_PUBLIC_URL,
  MODEL_DEPLOYMENT_MAX_ACTIVE_PER_SCOPE:
    process.env.MODEL_DEPLOYMENT_MAX_ACTIVE_PER_SCOPE,
  MODEL_DEPLOY_CHECK_MAX_PER_HOUR: process.env.MODEL_DEPLOY_CHECK_MAX_PER_HOUR,
});
// Each service credential is generated separately: a value shared by two
// services lets either impersonate the other (see README, secret rotation).
assertDistinctServiceSecrets({
  INTERNAL_INTROSPECTION_SECRET: internalServiceSecret,
  MODEL_API_SERVICE_TOKEN: modelsConfig.modelApi?.token,
  GATEWAY_SERVICE_READ_TOKEN: modelsConfig.gateway?.token,
});
if (!modelsConfig.modelApi || !modelsConfig.gateway) {
  console.warn(
    "MODEL_API_* or MLFLOW_GATEWAY_INTERNAL_URL/GATEWAY_SERVICE_READ_TOKEN are not set: the Models section answers 503",
  );
}
// MLOPS-06 (automatic predictions). The worker runs inside this process; it
// only starts when the Model API is configured and it is not disabled.
const predictionEnv = {
  PREDICTION_WORKER_POLL_MS: process.env.PREDICTION_WORKER_POLL_MS,
  PREDICTION_MAX_ATTEMPTS: process.env.PREDICTION_MAX_ATTEMPTS,
  PREDICTION_CONCURRENCY: process.env.PREDICTION_CONCURRENCY,
  PREDICTION_BATCH_SIZE: process.env.PREDICTION_BATCH_SIZE,
  PREDICTION_RETRY_BASE_MS: process.env.PREDICTION_RETRY_BASE_MS,
  PREDICTION_RETRY_MAX_MS: process.env.PREDICTION_RETRY_MAX_MS,
  PREDICTION_MAX_JOB_AGE_MS: process.env.PREDICTION_MAX_JOB_AGE_MS,
  PREDICTION_WORKER_DISABLED: process.env.PREDICTION_WORKER_DISABLED,
};
const predictionConfig = predictionWorkerConfigFromEnv(predictionEnv);
const predictionMonitorConfig = predictionMonitorConfigFromEnv({
  PREDICTION_METRICS_INTERVAL_MS: process.env.PREDICTION_METRICS_INTERVAL_MS,
  PREDICTION_FAILED_WARN_THRESHOLD:
    process.env.PREDICTION_FAILED_WARN_THRESHOLD,
  PREDICTION_FAILED_WINDOW_MS: process.env.PREDICTION_FAILED_WINDOW_MS,
});
const modelsReconcileIntervalMs = positiveInteger(
  "MODELS_RECONCILE_INTERVAL_MS",
  process.env.MODELS_RECONCILE_INTERVAL_MS,
  30_000,
  3_600_000,
);
const modelApiClient =
  modelsConfig.modelApi && createModelApiClient(modelsConfig.modelApi);
const modelsService = createModelsService(database.prisma, {
  config: modelsConfig,
  modelApi: modelApiClient,
  registry:
    modelsConfig.gateway && createModelRegistryClient(modelsConfig.gateway),
});
const predictionWorker =
  modelApiClient && predictionWorkerEnabled(predictionEnv)
    ? createPredictionWorker(database.prisma, {
        config: predictionConfig,
        modelApi: modelApiClient,
        models: modelsService,
      })
    : undefined;
// Periodic maintenance, off the request path (never inside a GET): models are
// reconciled with the Model API (stale CHECKING rows, quarantines, orphans and
// the models of organizations with the Models section off), and the prediction
// queue gauge is logged. Both only read and log or call the private Model API.
const backgroundTasks = [
  ...(modelApiClient
    ? [
        createBackgroundTask({
          name: "models.reconcile",
          intervalMs: modelsReconcileIntervalMs,
          run: (signal) => modelsService.reconcile({ signal }),
        }),
      ]
    : []),
  createBackgroundTask({
    name: "predictions.queue",
    intervalMs: predictionMonitorConfig.intervalMs,
    run: () => reportPredictionQueue(database.prisma, predictionMonitorConfig),
  }),
];
const app = createApp(database, createAuthService(database.prisma), {
  authRateLimiter: createAuthRateLimiterFromConfig(authRateLimitConfig),
  // The same kill switch as the login limiter (local e2e runs only).
  ...(authRateLimitConfig.disabled
    ? {
        apiTokenIssuanceLimiter: disabledAuthRateLimiter,
        mlflowAuthorizeLimiter: disabledAuthRateLimiter,
        internalAuthLimiter: disabledAuthRateLimiter,
      }
    : {}),
  trustProxyHops,
  publicOrigin,
  internalServiceSecret,
  mlflowCallbackUrl,
  groups: createGroupCatalogService(database.prisma),
  businessPolicies: createBusinessPolicyService(database.prisma),
  models: modelsService,
});

// Aborted when the process starts its graceful stop; the startup backfill
// listens to it.
const shutdownSignal = new AbortController();
let startupBackfill: Promise<unknown> = Promise.resolve();

const server = app.listen(port, host, () => {
  console.info(`InvoiceOps backend listening on ${host}:${port}`);
  // Idempotent backfill of Invoice.supplierKey (rows from before the column or
  // from an older release); the worker starts after it so priors are complete.
  // A failure is logged and does not block the worker: the rows keep a NULL
  // key and the next start retries.
  // SIGTERM aborts it between batches without a spurious failure log.
  startupBackfill = runStartupSupplierKeyBackfill(
    database.prisma,
    shutdownSignal.signal,
  ).finally(() => {
    if (!shuttingDown) {
      predictionWorker?.start();
      for (const task of backgroundTasks) task.start();
    }
  });
});

// Graceful stop (docker stop sends SIGTERM): stop accepting connections, let
// in-flight requests finish, release the database pool, then exit. A hard
// deadline keeps a stuck connection from outliving the orchestrator's grace
// period (compose.production.yml `stop_grace_period` must stay above it). It
// is shorter than the Model API predict timeout (15 s) and the ensureLoaded
// wait (120 s) on purpose: the prediction worker and the models reconcile
// task abort their in-flight Model API calls on stop() (the worker also
// releases its claims), so a clean exit does not depend on those calls
// finishing.
const SHUTDOWN_DEADLINE_MS = 10_000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownSignal.abort();
  const deadline = setTimeout(() => {
    logEvent("error", "shutdown", { reason: signal, outcome: "timeout" });
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref();
  // Stops polling now and aborts in-flight Model API calls (claims are released).
  const workerStopped = Promise.all([
    startupBackfill,
    predictionWorker?.stop(),
    ...backgroundTasks.map((task) => task.stop()),
  ]);

  server.close((closeError) => {
    // Idle keep-alive sockets are dropped by close(); the callback fires once
    // the in-flight requests are done. The prediction worker has released every
    // claim it held (aborted and unstarted ones) before the pool closes.
    workerStopped
      .then(() => database.close())
      .then(() => (closeError ? Promise.reject(closeError) : undefined))
      .then(
        () => {
          logEvent("info", "shutdown", { reason: signal, outcome: "clean" });
          process.exit(0);
        },
        (error: unknown) => {
          logEvent("error", "shutdown", {
            reason: signal,
            outcome: "failed",
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
          process.exit(1);
        },
      );
  });
  server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
