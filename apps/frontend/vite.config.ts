/// <reference types="vitest/config" />

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/auth": "http://localhost:3000",
      "/profile": "http://localhost:3000",
      "/groups": "http://localhost:3000",
      "/invoices": "http://localhost:3000",
      "/resources": "http://localhost:3000",
      "/mlflow/resources": "http://localhost:3000",
      "/organizations": "http://localhost:3000",
      "^/evidence-(?:records(?:/[^/?]+)?|batches(?:/[^/?]+(?:/proofs/[^/?]+)?)?)(?:\\?|$)":
        {
          target: "http://localhost:3000",
          changeOrigin: false,
          xfwd: true,
        },
      "^/business-policies(?:/[^/?]+)?(?:\\?|$)": {
        target: "http://localhost:3000",
        changeOrigin: false,
        xfwd: true,
      },
      "^/platform/organizations(?:\\?|$)": {
        target: "http://localhost:3000",
        changeOrigin: false,
        xfwd: true,
      },
      "^/platform/organizations/[^/?]+/members(?:/[^/?]+)?(?:\\?|$)": {
        target: "http://localhost:3000",
        changeOrigin: false,
        xfwd: true,
      },
    },
  },
  test: {
    environment: "jsdom",
  },
});
