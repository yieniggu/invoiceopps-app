import request from "../support/request.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import {
  enumerateMountedRoutes,
  enumerateOpenApiRoutes,
  routeKey,
} from "./route-parity.js";

type Json = Record<string, unknown>;

const ORGANIZATION_OPERATIONS = [
  ["get", "/api/v1/organizations"],
  ["post", "/api/v1/organizations"],
  ["get", "/api/v1/organizations/{organizationId}"],
  ["patch", "/api/v1/organizations/{organizationId}"],
  ["get", "/api/v1/organizations/{organizationId}/members"],
  ["get", "/api/v1/organizations/{organizationId}/memberships"],
  ["put", "/api/v1/organizations/{organizationId}/memberships/permissions"],
  ["post", "/api/v1/organizations/{organizationId}/memberships"],
  ["patch", "/api/v1/organizations/{organizationId}/memberships/{userId}"],
  ["delete", "/api/v1/organizations/{organizationId}/memberships/{userId}"],
  ["get", "/api/v1/organizations/{organizationId}/users"],
  ["post", "/api/v1/organizations/{organizationId}/users"],
  ["patch", "/api/v1/profile"],
] as const;

const REMOVED_LEGACY = [
  "GET /api/v1/platform/organizations",
  "POST /api/v1/platform/organizations",
  "POST /api/v1/platform/organizations/{organizationId}/members",
  "PATCH /api/v1/platform/organizations/{organizationId}/members/{userId}",
  "DELETE /api/v1/platform/organizations/{organizationId}/members/{userId}",
  "POST /api/v1/platform/users",
];

const buildApp = () => createApp({ isReady: async () => true });

describe("RP0-06/RP0-08 organization OpenAPI contract", () => {
  let document: Json;

  beforeAll(async () => {
    const response = await request(buildApp()).get("/openapi.json");
    document = (response.status === 200 ? response.body : {}) as Json;
  });

  it.each(ORGANIZATION_OPERATIONS)("documents %s %s", (method, path) => {
    const documented = enumerateOpenApiRoutes(document).map((route) =>
      routeKey(route.method, route.path),
    );
    expect(documented).toContain(routeKey(method, path));
  });

  it("documents the strict request bodies of the write operations", () => {
    const paths = (document.paths ?? {}) as Record<string, Json>;
    const bodyOf = (path: string, method: string) => {
      const operation = paths[path]?.[method] as Json | undefined;
      const content = (operation?.requestBody as Json | undefined)?.content as
        Record<string, Json> | undefined;
      return content?.["application/json"]?.schema;
    };
    for (const [method, path] of ORGANIZATION_OPERATIONS) {
      if (method === "get" || method === "delete") continue;
      expect(bodyOf(path, method), `${method} ${path}`).toBeDefined();
    }
  });

  it("documents the optional temporaryPassword in both create-user requests and responses", () => {
    const schemas = ((document.components as Json | undefined)?.schemas ??
      {}) as Record<string, Json>;
    const property = (schema: string, name: string) =>
      ((schemas[schema]?.properties ?? {}) as Record<string, Json>)[name];
    const required = (schema: string) =>
      (schemas[schema]?.required ?? []) as string[];

    for (const schema of ["UserProvisionRequest", "AdminUserCreateRequest"]) {
      expect(property(schema, "temporaryPassword"), schema).toMatchObject({
        type: "string",
        minLength: 8,
        maxLength: 256,
      });
      expect(required(schema), schema).not.toContain("temporaryPassword");
    }
    for (const schema of ["UserProvisionResponse", "AdminUserCreateResponse"]) {
      expect(property(schema, "temporaryPassword"), schema).toBeDefined();
      expect(required(schema), schema).not.toContain("temporaryPassword");
    }
  });

  it("documents the organization summary and the bulk permission contracts", () => {
    const schemas = ((document.components as Json | undefined)?.schemas ??
      {}) as Record<string, Json>;
    const properties = (schema: string) =>
      (schemas[schema]?.properties ?? {}) as Record<string, Json>;
    const required = (schema: string) =>
      (schemas[schema]?.required ?? []) as string[];

    expect(
      Object.keys(properties("OrganizationDetailResponse")).sort(),
    ).toEqual(["organization", "summary"]);
    expect(Object.keys(properties("OrganizationBasic")).sort()).toEqual([
      "description",
      "id",
      "name",
      "slug",
    ]);
    expect(Object.keys(properties("OrganizationCounts")).sort()).toEqual([
      "groupCount",
      "memberCount",
    ]);
    expect(properties("BulkPermissionsUpdateRequest").userIds).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: { type: "string", format: "uuid" },
    });
    expect(required("BulkPermissionsUpdateRequest").sort()).toEqual([
      "permissions",
      "userIds",
    ]);
    expect(schemas.BulkPermissionsUpdateRequest?.additionalProperties).toBe(
      false,
    );
    expect(properties("MembershipsResponse").memberships).toMatchObject({
      type: "array",
    });
  });

  it("no longer documents or mounts the legacy platform routes", () => {
    const documented = enumerateOpenApiRoutes(document).map((route) =>
      routeKey(route.method, route.path),
    );
    const mounted = enumerateMountedRoutes(buildApp()).map((route) =>
      routeKey(route.method, route.path),
    );

    for (const key of REMOVED_LEGACY) {
      expect(documented, key).not.toContain(key);
      expect(mounted, key).not.toContain(key);
    }
  });

  it("no longer lists the legacy platform routes or PATCH /profile in LEGACY_ROUTES", async () => {
    const { LEGACY_ROUTES } = await import("../../src/http/registry.js");
    const keys = LEGACY_ROUTES.map((route) =>
      routeKey(route.method, route.path),
    );

    for (const key of [...REMOVED_LEGACY, "PATCH /api/v1/profile"]) {
      expect(keys, key).not.toContain(key);
    }
  });
});
