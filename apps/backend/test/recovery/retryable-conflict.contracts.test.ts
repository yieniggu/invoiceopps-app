import request from "../support/request.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";

type Json = Record<string, unknown>;

// Operations that run inside runSerializable and can exhaust its retries.
const SERIALIZABLE_OPERATIONS = [
  ["patch", "/api/v1/organizations/{organizationId}"],
  ["post", "/api/v1/organizations/{organizationId}/memberships"],
  ["patch", "/api/v1/organizations/{organizationId}/memberships/{userId}"],
  ["delete", "/api/v1/organizations/{organizationId}/memberships/{userId}"],
  [
    "put",
    "/api/v1/organizations/{organizationId}/memberships/{userId}/permissions",
  ],
  ["put", "/api/v1/organizations/{organizationId}/memberships/permissions"],
  [
    "put",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/{userId}/permissions",
  ],
  [
    "post",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships",
  ],
  [
    "post",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/bulk",
  ],
  [
    "put",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/permissions",
  ],
  [
    "delete",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/{userId}",
  ],
  ["post", "/api/v1/organizations/{organizationId}/users"],
  ["post", "/api/v1/admin/users"],
  ["post", "/api/v1/admin/users/{userId}/deactivation"],
  ["delete", "/api/v1/admin/users/{userId}/deactivation"],
  ["patch", "/api/v1/admin/users/{userId}"],
  ["post", "/api/v1/admin/users/{userId}/password-reset"],
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
