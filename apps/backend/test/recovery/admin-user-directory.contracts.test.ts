import request from "../support/request.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";

type Json = Record<string, unknown>;
type OperationDocument = {
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  requestBody?: unknown;
  responses: Record<string, { headers?: Record<string, unknown> }>;
};

const LIST = "/api/v1/admin/users";
const DETAIL = "/api/v1/admin/users/{userId}";
const RESET = "/api/v1/admin/users/{userId}/password-reset";

describe("AC-12 admin user directory OpenAPI contract", () => {
  let paths: Record<string, Record<string, OperationDocument>>;

  beforeAll(async () => {
    const response = await request(
      createApp({ isReady: async () => true }),
    ).get("/openapi.json");
    paths = (response.body as Json).paths as typeof paths;
  });

  it.each([
    ["get", LIST, [200, 400, 401, 403]],
    ["get", DETAIL, [200, 401, 403, 404]],
    ["patch", DETAIL, [200, 400, 401, 403, 404, 409, 503]],
    ["post", RESET, [200, 400, 401, 403, 404, 409, 503]],
  ] as const)("documents %s %s", (method, path, statuses) => {
    const operation = paths[path]?.[method];
    expect(operation, `${method} ${path} is documented`).toBeDefined();
    for (const status of statuses) {
      expect(
        Object.keys(operation!.responses),
        `${method} ${path} documents ${status}`,
      ).toContain(String(status));
    }
  });

  it("documents the list query parameters as optional query parameters", () => {
    const parameters = paths[LIST]?.get?.parameters ?? [];
    const query = parameters.filter((parameter) => parameter.in === "query");
    expect(query.map((parameter) => parameter.name).sort()).toEqual([
      "page",
      "pageSize",
      "search",
      "status",
    ]);
    expect(query.every((parameter) => parameter.required !== true)).toBe(true);
  });

  it("documents Cache-Control: no-store on the password reset success", () => {
    const success = paths[RESET]?.post?.responses["200"];
    expect(success?.headers).toHaveProperty("Cache-Control");
  });

  it("documents a request body on PATCH and on the reset only", () => {
    expect(paths[DETAIL]?.patch?.requestBody).toBeDefined();
    expect(paths[RESET]?.post?.requestBody).toBeDefined();
    expect(paths[LIST]?.get?.requestBody).toBeUndefined();
    expect(paths[DETAIL]?.get?.requestBody).toBeUndefined();
  });
});
