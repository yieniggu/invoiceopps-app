import request from "../support/request.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import {
  enumerateMountedRoutes,
  enumerateOpenApiRoutes,
  routeKey,
} from "./route-parity.js";

type Json = Record<string, unknown>;

const GROUP_OPERATIONS = [
  ["get", "/api/v1/organizations/{organizationId}/groups"],
  ["post", "/api/v1/organizations/{organizationId}/groups"],
  ["patch", "/api/v1/organizations/{organizationId}/groups/{groupId}"],
  [
    "get",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships",
  ],
  [
    "post",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships",
  ],
  [
    "delete",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/{userId}",
  ],
] as const;

const REMOVED_LEGACY = [
  "DELETE /api/v1/organizations/{organizationId}/groups/{groupId}",
  "POST /api/v1/organizations/{organizationId}/groups/{groupId}/members",
  "DELETE /api/v1/organizations/{organizationId}/groups/{groupId}/members/{userId}",
];

const PERMISSIONS = [
  "readInvoices",
  "createInvoices",
  "deleteOwnInvoices",
  "deleteOthersInvoices",
];

const buildApp = () => createApp({ isReady: async () => true });

describe("RP0-07 group OpenAPI contract", () => {
  let document: Json;

  beforeAll(async () => {
    const response = await request(buildApp()).get("/openapi.json");
    document = (response.status === 200 ? response.body : {}) as Json;
  });

  it.each(GROUP_OPERATIONS)("documents %s %s", (method, path) => {
    const documented = enumerateOpenApiRoutes(document).map((route) =>
      routeKey(route.method, route.path),
    );
    expect(documented).toContain(routeKey(method, path));
  });

  it("documents the PATCH body as the four required boolean flags and nothing else", () => {
    const paths = (document.paths ?? {}) as Record<string, Json>;
    const operation = paths[
      "/api/v1/organizations/{organizationId}/groups/{groupId}"
    ]?.patch as Json | undefined;
    const content = (operation?.requestBody as Json | undefined)?.content as
      Record<string, Json> | undefined;
    const body = content?.["application/json"]?.schema as Json | undefined;

    expect(body, "PATCH request body").toBeDefined();
    const schemas = ((document.components as Json | undefined)?.schemas ??
      {}) as Record<string, Json>;
    const resolve = (schema: Json | undefined): Json | undefined => {
      const ref = schema?.$ref;
      return typeof ref === "string"
        ? schemas[ref.split("/").pop() as string]
        : schema;
    };
    const root = resolve(body);
    expect(root?.additionalProperties).toBe(false);
    expect(root?.required).toEqual(["permissions"]);
    const permissions = resolve(
      (root?.properties as Record<string, Json>).permissions,
    );
    expect(permissions?.additionalProperties).toBe(false);
    expect([...((permissions?.required as string[]) ?? [])].sort()).toEqual(
      [...PERMISSIONS].sort(),
    );
    for (const flag of PERMISSIONS) {
      expect(
        (permissions?.properties as Record<string, Json>)[flag]?.type,
      ).toBe("boolean");
    }
  });

  it("documents the group membership POST body without any permission field", () => {
    const paths = (document.paths ?? {}) as Record<string, Json>;
    const operation = paths[
      "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships"
    ]?.post as Json | undefined;
    const content = (operation?.requestBody as Json | undefined)?.content as
      Record<string, Json> | undefined;
    const ref = (content?.["application/json"]?.schema as Json | undefined)
      ?.$ref as string | undefined;
    const schemas = ((document.components as Json | undefined)?.schemas ??
      {}) as Record<string, Json>;
    const text = JSON.stringify(schemas[String(ref).split("/").pop() ?? ""]);
    for (const flag of PERMISSIONS) expect(text).not.toContain(flag);
    expect(text).toContain("userId");
  });

  it("no longer documents or mounts the removed legacy group routes", () => {
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

  it("keeps only GET /api/v1/groups as a legacy group route, owned by LEGACY-NO-P0", async () => {
    const { LEGACY_ROUTES } = await import("../../src/http/registry.js");
    const groupRoutes = LEGACY_ROUTES.filter((route) =>
      route.path.includes("/groups"),
    );

    expect(groupRoutes).toEqual([
      { method: "GET", path: "/api/v1/groups", owner: "LEGACY-NO-P0" },
    ]);
  });
});
