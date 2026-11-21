import { beforeAll, describe, expect, it } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";

type Json = Record<string, unknown>;

const OPERATIONS = [
  ["/api/v1/models", "get"],
  ["/api/v1/deployments", "get"],
  ["/api/v1/deployments", "post"],
  ["/api/v1/deployments/{deploymentId}", "patch"],
] as const;

let paths: Record<string, Json | undefined>;

beforeAll(async () => {
  const response = await request(createApp({ isReady: async () => true })).get(
    "/openapi.json",
  );
  paths = response.body.paths as Record<string, Json | undefined>;
});

describe("Models operations document both 503 causes", () => {
  it.each(OPERATIONS)(
    "%s %s documents SERVICE_UNAVAILABLE and RETRYABLE_CONFLICT with Retry-After",
    (path, method) => {
      const operation = (paths[path]?.[method] ?? {}) as Json;
      const response = (operation.responses as Record<string, Json>)?.["503"];
      expect(response).toBeDefined();
      const description = String(response?.description);
      expect(description).toContain("SERVICE_UNAVAILABLE");
      expect(description).toContain("RETRYABLE_CONFLICT");
      expect(
        (response?.headers as Record<string, Json> | undefined)?.[
          "Retry-After"
        ],
      ).toBeDefined();
    },
  );
});
