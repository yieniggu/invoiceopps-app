import request from "../support/request.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";

type Json = Record<string, unknown>;

// Operations that run inside runSerializable and can exhaust its retries.
const SERIALIZABLE_OPERATIONS = [
  ["post", "/api/v1/organizations/{organizationId}/memberships"],
  ["patch", "/api/v1/organizations/{organizationId}/memberships/{userId}"],
  ["delete", "/api/v1/organizations/{organizationId}/memberships/{userId}"],
  ["patch", "/api/v1/organizations/{organizationId}/groups/{groupId}"],
  [
    "post",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships",
  ],
  [
    "delete",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/{userId}",
  ],
] as const;

describe("CR-102 RETRYABLE_CONFLICT contract", () => {
  let document: Json;

  beforeAll(async () => {
    const response = await request(
      createApp({ isReady: async () => true }),
    ).get("/openapi.json");
    document = response.body as Json;
  });

  it.each(SERIALIZABLE_OPERATIONS)("documents 503 on %s %s", (method, path) => {
    const paths = document.paths as Record<string, Record<string, Json>>;
    const responses = paths[path]?.[method]?.responses as Record<string, Json>;
    const documented = responses?.["503"];

    expect(documented?.description).toContain("RETRYABLE_CONFLICT");
    expect(documented?.headers).toHaveProperty("Retry-After");
  });

  it("lists RETRYABLE_CONFLICT in the Error envelope codes", () => {
    const schemas = (document.components as Json).schemas as Record<
      string,
      { properties: { error: { properties: { code: { enum: string[] } } } } }
    >;

    expect(schemas.Error.properties.error.properties.code.enum).toContain(
      "RETRYABLE_CONFLICT",
    );
  });
});
