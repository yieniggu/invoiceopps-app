import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/generated/**", "**/node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // supertest(app) opens an ephemeral listener per request, which is flaky
    // under load; backend HTTP tests use the loopback helper instead.
    files: ["apps/backend/test/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "supertest",
              message: "Import request from test/support/request.ts instead.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/backend/test/support/request.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Authenticated calls go through protectedFetch so a mid-session
    // ONBOARDING_REQUIRED reaches the forced password-change screen.
    files: ["apps/frontend/src/**/*.{ts,tsx}"],
    ignores: [
      "**/*.test.{ts,tsx}",
      "apps/frontend/src/features/auth/api/protectedFetch.ts",
      // Login is the one unauthenticated call (there is no session yet).
      "apps/frontend/src/features/auth/api/authApi.ts",
    ],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "Use protectedFetch from features/auth/api/protectedFetch.",
        },
      ],
    },
  },
);
