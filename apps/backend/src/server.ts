import { createApp } from "./app.js";
import { createAuthService } from "./auth.js";
import {
  authRateLimitConfigFromEnv,
  createAuthRateLimiterFromConfig,
} from "./auth-rate-limit.js";
import { createBusinessPolicyService } from "./business-policies.js";
import { createDatabase } from "./database.js";
import { createGroupCatalogService } from "./features/groups/services.js";
import { publicOriginFromEnv } from "./http/public-origin.js";
import { logEvent } from "./http/logging.js";
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
const app = createApp(database, createAuthService(database.prisma), {
  authRateLimiter: createAuthRateLimiterFromConfig(authRateLimitConfig),
  trustProxyHops,
  publicOrigin,
  groups: createGroupCatalogService(database.prisma),
  businessPolicies: createBusinessPolicyService(database.prisma),
});

const server = app.listen(port, host, () => {
  console.info(`InvoiceOps backend listening on ${host}:${port}`);
});

// Graceful stop (docker stop sends SIGTERM): stop accepting connections, let
// in-flight requests finish, release the database pool, then exit. A hard
// deadline keeps a stuck connection from outliving the orchestrator's grace
// period.
const SHUTDOWN_DEADLINE_MS = 10_000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => {
    logEvent("error", "shutdown", { reason: signal, outcome: "timeout" });
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref();

  server.close((closeError) => {
    // Idle keep-alive sockets are dropped by close(); the callback fires once
    // the in-flight requests are done.
    database
      .close()
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
