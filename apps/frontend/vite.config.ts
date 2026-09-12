/// <reference types="vitest/config" />

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/auth": "http://localhost:3000",
      "/profile": "http://localhost:3000",
      "/groups": "http://localhost:3000",
      "/organizations": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
  },
});
