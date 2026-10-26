/// <reference types="vitest/config" />

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
  plugins: [react(), tailwindcss()],
  server: {
    port: 5380,
    strictPort: true,
    proxy: {
      "/auth": sameOriginRule,
      "/profile": sameOriginRule,
      "/groups": sameOriginRule,
      "/invoices": sameOriginRule,
      "/organizations": sameOriginRule,
      "^/business-policies(?:/[^/?]+)?(?:\\?|$)": {
        target: backendTarget,
        changeOrigin: false,
        xfwd: true,
      },
      "^/platform/organizations(?:\\?|$)": {
        target: backendTarget,
        changeOrigin: false,
        xfwd: true,
      },
      "^/platform/organizations/[^/?]+/members(?:/[^/?]+)?(?:\\?|$)": {
        target: backendTarget,
        changeOrigin: false,
        xfwd: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    testTimeout: 15000,
    maxWorkers: 4,
  },
});
