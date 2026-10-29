import { defineConfig } from "@playwright/test";

import { BACKEND_PORT, BASE_URL, FRONTEND_PORT } from "./support/env.ts";

/**
 * The isolated recovery test database, never the development one. Same shape
 * as LOCAL_RUN.md: POSTGRES_* and LOCAL_APP_DB_PORT come from the root .env
 * the person loaded in the shell (`set -a; . ./.env; set +a`). The backend
 * launcher re-validates the name and recreates the database on every run.
 */
function recoveryTestDatabaseUrl() {
  const explicit = process.env.RECOVERY_TEST_DATABASE_URL;
  if (explicit) return explicit;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const port = process.env.LOCAL_APP_DB_PORT ?? "5545";
  if (!user || !password) {
    throw new Error(
      "Set RECOVERY_TEST_DATABASE_URL, or load the root .env so POSTGRES_USER and POSTGRES_PASSWORD exist (see LOCAL_RUN.md)",
    );
  }
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/invoiceops_recovery_test?schema=public`;
}

const desktop = { width: 1440, height: 900 };

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
      use: { viewport: desktop, colorScheme: "light" },
    },
    {
      name: "mobile",
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
      use: { viewport: desktop, colorScheme: "dark" },
    },
  ],
  webServer: [
    {
      // Recreates + migrates + seeds the recovery test database, then serves.
      command: "pnpm --filter @invoiceops/backend e2e:server",
      url: `http://127.0.0.1:${BACKEND_PORT}/health/ready`,
      timeout: 240_000,
      reuseExistingServer: Boolean(process.env.E2E_REUSE_SERVERS),
      env: {
        RECOVERY_TEST_DATABASE_URL: recoveryTestDatabaseUrl(),
        E2E_BACKEND_PORT: String(BACKEND_PORT),
      },
    },
    {
      // The proxy target comes from PORT, as in `pnpm dev`.
      command: `pnpm --filter @invoiceops/frontend exec vite --host 127.0.0.1 --port ${FRONTEND_PORT}`,
      url: BASE_URL,
      timeout: 120_000,
      reuseExistingServer: Boolean(process.env.E2E_REUSE_SERVERS),
      env: { PORT: String(BACKEND_PORT) },
    },
  ],
});
