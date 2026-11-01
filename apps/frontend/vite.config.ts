/// <reference types="vitest/config" />

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tests that build local dates (expiry, DST) must not depend on the machine's
// zone. Set before any worker starts so the forked workers inherit it; it
// matches the zone Playwright pins in the e2e suite.
process.env.TZ = "America/Santiago";

// Non-default local ports avoid clashing with other apps on 3000/5173. The
// IPv4 loopback target avoids `localhost` resolving to another IPv4/IPv6 server.
// The port comes from the same PORT variable the backend reads, so
// `PORT=… pnpm dev` keeps proxy and backend aligned.
const backendTarget = `http://127.0.0.1:${process.env.PORT || "4380"}`;
// Vite's string shorthand rewrites Host to the target, which breaks the
// backend's cookie Origin check; every rule keeps the browser's Host.
const sameOriginRule = {
  target: backendTarget,
  changeOrigin: false,
  xfwd: true,
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5380,
    strictPort: true,
    proxy: {
      "/api/": sameOriginRule,
      // The bare `/api` reaches the backend, whose 404 envelope matches the one
      // nginx answers for `location = /api`.
      "^/api(?:\\?|$)": sameOriginRule,
      "^/openapi\\.json(?:\\?|$)": sameOriginRule,
      // Swagger UI served by the backend: /docs, /docs/ and its assets.
      "^/docs(?:/|\\?|$)": sameOriginRule,
    },
  },
  test: {
    environment: "jsdom",
    testTimeout: 15000,
    // Each worker is a jsdom + React process and a test mostly waits on CPU.
    // Four keep a 10-core development machine (which also runs Docker and
    // PostgreSQL) from oversubscribing: stress runs with 8 workers plus 8 busy
    // processes made the first App render of a file take several seconds and
    // failed the first test of App.s8, session.ui and routes.ui (see the
    // asyncUtilTimeout note in src/test/setup.ts). A plain run takes ~45 s.
    maxWorkers: 4,
    setupFiles: ["./src/test/setup.ts"],
  },
});
