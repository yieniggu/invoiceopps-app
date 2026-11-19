import { defineConfig } from "@playwright/test";

import { parseDemoHeadless, parseDemoSlowMo } from "./support/demo-env.ts";
import { BACKEND_PORT, BASE_URL, FRONTEND_PORT } from "./support/env.ts";

/**
 * The dedicated E2E database: never the development one, and never the
 * recovery test database of `pnpm test:recovery:postgres`, so both suites can
 * run at the same time. Same shape as LOCAL_RUN.md: POSTGRES_* and
 * LOCAL_APP_DB_PORT come from the root .env the person loaded in the shell
 * (`set -a; . ./.env; set +a`). The backend launcher re-validates the name and
 * recreates the database on every run.
 */
function recoveryE2eDatabaseUrl() {
  const explicit = process.env.RECOVERY_E2E_DATABASE_URL;
  if (explicit) return explicit;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const port = process.env.LOCAL_APP_DB_PORT ?? "5545";
  if (!user || !password) {
    throw new Error(
      "Set RECOVERY_E2E_DATABASE_URL, or load the root .env so POSTGRES_USER and POSTGRES_PASSWORD exist (see LOCAL_RUN.md)",
    );
  }
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/invoiceops_recovery_e2e?schema=public`;
}

const desktop = { width: 1440, height: 900 };

/**
 * The classroom demo (`pnpm demo:rpa`) is opt-in: the `demo` project only exists
 * with RPA_DEMO=1 (the e2e `demo:rpa*` scripts set it), so `playwright test`,
 * `test:e2e` and CI never open it. The other projects always ignore its spec.
 */
const demoSpec = /rpa-demo\.spec\.ts/;
const demoEnabled = process.env.RPA_DEMO === "1";
const demoHeadless = demoEnabled
  ? parseDemoHeadless(process.env.RPA_DEMO_HEADLESS)
  : false;
// Slow motion makes the bot followable on a projector; headless runs skip it.
const demoSlowMo = demoEnabled
  ? parseDemoSlowMo(process.env.RPA_DEMO_SLOWMO, demoHeadless)
  : 0;

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./support/global-setup.ts",
  // Drops the ARIA snapshots of failures in the specs that show a password.
  globalTeardown: "./support/global-teardown.ts",
  outputDir: "./test-results",
  // Every test builds its own data (see support/scenario.ts), so files can run
  // side by side; the seeded fixtures are only read.
  fullyParallel: true,
  workers: Number(process.env.E2E_WORKERS ?? 3),
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    locale: "es-CL",
    timezoneId: "America/Santiago",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: demoSpec,
      use: { viewport: desktop, colorScheme: "light" },
    },
    {
      name: "mobile",
      // The RP0-20 journey proves cross-surface behavior, not layout: it runs
      // on the desktop projects (light and dark) only.
      testIgnore: [/recovery-journey\.spec\.ts/, demoSpec],
      use: {
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
        colorScheme: "light",
      },
    },
    {
      name: "desktop-dark",
      testIgnore: demoSpec,
      use: { viewport: desktop, colorScheme: "dark" },
    },
    ...(demoEnabled
      ? [
          {
            name: "demo",
            testMatch: demoSpec,
            use: {
              viewport: desktop,
              colorScheme: "light" as const,
              headless: demoHeadless,
              video: { mode: "on" as const, size: desktop },
              // The spec records its own trace into the run folder of
              // demo-output (see tests/rpa-demo.spec.ts): the one Playwright
              // writes to test-results is replaced by the next run.
              trace: "off" as const,
              screenshot: "on" as const,
              launchOptions: { slowMo: demoSlowMo },
            },
          },
        ]
      : []),
  ],
  webServer: [
    {
      // Recreates + migrates + seeds the dedicated E2E database, then serves.
      command: "pnpm --filter @invoiceops/backend e2e:server",
      url: `http://127.0.0.1:${BACKEND_PORT}/health/ready`,
      timeout: 240_000,
      // Default is SIGKILL on the process group; SIGTERM lets the launcher
      // stop its server and tsx child cleanly.
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      reuseExistingServer: Boolean(process.env.E2E_REUSE_SERVERS),
      env: {
        RECOVERY_E2E_DATABASE_URL: recoveryE2eDatabaseUrl(),
        E2E_BACKEND_PORT: String(BACKEND_PORT),
      },
    },
    {
      // The proxy target comes from PORT, as in `pnpm dev`.
      command: `pnpm --filter @invoiceops/frontend exec vite --host 127.0.0.1 --port ${FRONTEND_PORT}`,
      url: BASE_URL,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      reuseExistingServer: Boolean(process.env.E2E_REUSE_SERVERS),
      env: { PORT: String(BACKEND_PORT) },
    },
  ],
});
