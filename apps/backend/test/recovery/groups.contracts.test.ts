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
  [
    "get",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships",
  ],
  [
    "put",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/{userId}/permissions",
  ],
  [
    "put",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/permissions",
  ],
  [
    "post",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/bulk",
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
  "PATCH /api/v1/organizations/{organizationId}/groups/{groupId}",
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

  it.each([
    "/api/v1/organizations/{organizationId}/memberships/{userId}/permissions",
    "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/{userId}/permissions",
  ])(
    "documents the PUT body of %s as the four required boolean flags and nothing else",
    (path) => {
      const paths = (document.paths ?? {}) as Record<string, Json>;
      const operation = paths[path]?.put as Json | undefined;
      const content = (operation?.requestBody as Json | undefined)?.content as
        Record<string, Json> | undefined;
      const body = content?.["application/json"]?.schema as Json | undefined;

      expect(body, "PUT request body").toBeDefined();
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
    },
  );

  it("documents the group membership POST body with userId and optional permissions", () => {
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
    const body = schemas[String(ref).split("/").pop() ?? ""];

    expect(body.required).toEqual(["userId"]);
    expect(Object.keys(body.properties as Json).sort()).toEqual([
      "permissions",
      "userId",
    ]);
    expect(body.additionalProperties).toBe(false);
  });

  it("documents the bulk request bodies (1..200 unique members, strict)", () => {
    const schemas = ((document.components as Json | undefined)?.schemas ??
      {}) as Record<string, Json>;
    const bulk = schemas.GroupMembershipBulkCreateRequest;
    const members = (bulk?.properties as Record<string, Json>).members;

    expect(bulk?.required).toEqual(["members"]);
    expect(bulk?.additionalProperties).toBe(false);
    expect(members).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 200,
    });
    const item = members.items as Json;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["userId"]);
    expect(
      ((item.properties as Record<string, Json>).userId as Json).format,
    ).toBe("uuid");
    expect(
      Object.keys(schemas.GroupMembershipsResponse?.properties as Json),
    ).toEqual(["memberships"]);

    const paths = (document.paths ?? {}) as Record<string, Json>;
    const post = paths[
      "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/bulk"
    ]?.post as Json;
    expect(Object.keys(post.responses as Json)).toEqual(
      expect.arrayContaining(["201", "400", "401", "403", "404", "409", "503"]),
    );
    const put = paths[
      "/api/v1/organizations/{organizationId}/groups/{groupId}/memberships/permissions"
    ]?.put as Json;
    expect(Object.keys(put.responses as Json)).toEqual(
      expect.arrayContaining(["200", "400", "401", "403", "404", "503"]),
    );
  });

  it("documents the Group schema without any permission flag", () => {
    const schemas = ((document.components as Json | undefined)?.schemas ??
      {}) as Record<string, Json>;
    expect(Object.keys(schemas.Group.properties as Json).sort()).toEqual([
      "description",
      "id",
      "name",
      "organizationId",
    ]);
    expect(JSON.stringify(schemas.Group)).not.toContain("Invoices");
  });

  it("documents memberships with permissions and the group membership with permissions", () => {
    const schemas = ((document.components as Json | undefined)?.schemas ??
      {}) as Record<string, Json>;
    expect(schemas.GroupMembership.required).toEqual(
      expect.arrayContaining(["permissions"]),
    );
    expect(schemas.Membership.required).toEqual(
      expect.arrayContaining(["permissions"]),
    );
    expect(Object.keys(schemas.MembershipWithUser.properties as Json)).toEqual(
      expect.arrayContaining(["permissions", "groups", "user"]),
    );
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
