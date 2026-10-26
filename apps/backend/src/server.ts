import { createApp } from "./app.js";
import { createAuthService } from "./auth.js";
import {
  authRateLimitConfigFromEnv,
  createAuthRateLimiterFromConfig,
} from "./auth-rate-limit.js";
import { createBusinessPolicyService } from "./business-policies.js";
import { createDatabase } from "./database.js";
import { createGroupService } from "./groups.js";
import { createInvoiceService } from "./invoices.js";
import { createPlatformAdministratorService } from "./platform-administrator.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be configured");
}
// Local default avoids 3000; containers set PORT explicitly.
const port = Number(process.env.PORT || 4380);
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
const app = createApp(database, createAuthService(database.prisma), {
  authRateLimiter: createAuthRateLimiterFromConfig(authRateLimitConfig),
  groups: createGroupService(database.prisma),
  invoices: createInvoiceService(database.prisma),
  businessPolicies: createBusinessPolicyService(database.prisma),
  platformAdministrators: createPlatformAdministratorService(database.prisma),
});

app.listen(port, () => {
  console.info(`InvoiceOps backend listening on port ${port}`);
});
