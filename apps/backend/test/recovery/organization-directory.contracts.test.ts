import request from "../support/request.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { enumerateMountedRoutes, routeKey } from "./route-parity.js";

type Json = Record<string, unknown>;
type OperationDocument = {
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  requestBody?: unknown;
  responses: Record<string, { headers?: Record<string, unknown> }>;
};

const ORG = "/api/v1/organizations/{organizationId}";
const MEMBERS = `${ORG}/members`;
const MEMBERSHIPS = `${ORG}/memberships`;
const USERS = `${ORG}/users`;
const GROUP_MEMBERSHIPS = `${ORG}/groups/{groupId}/memberships`;
const LIST = "/api/v1/organizations";
const USER = "/api/v1/users/{userId}";

describe("AC-08/09/10/22/23 organization directory OpenAPI contract", () => {
  let document: Json;
  let paths: Record<string, Record<string, OperationDocument>>;
  let schemas: Record<string, Json>;

  beforeAll(async () => {
    const response = await request(
      createApp({ isReady: async () => true }),
    ).get("/openapi.json");
    document = response.body as Json;
    paths = document.paths as typeof paths;
    schemas = ((document.components as Json | undefined)?.schemas ??
      {}) as Record<string, Json>;
  });

  it.each([
    ["patch", ORG, [200, 400, 401, 403, 404, 503]],
    ["get", MEMBERS, [200, 400, 401, 403, 404]],
    ["get", MEMBERSHIPS, [200, 400, 401, 403, 404]],
    ["get", LIST, [200, 400, 401, 403]],
    ["get", USER, [200, 401, 403, 404]],
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

  it("mounts every documented operation", () => {
    const mounted = enumerateMountedRoutes(
      createApp({ isReady: async () => true }),
    ).map((route) => routeKey(route.method, route.path));
    for (const [method, path] of [
      ["patch", ORG],
      ["get", MEMBERS],
      ["get", USER],
    ]) {
      expect(mounted).toContain(routeKey(method!, path!));
    }
  });

  it("documents the page and pageSize query of the three lists, search on organizations only and userIds on memberships only", () => {
    const names = (path: string) =>
      (paths[path]?.get?.parameters ?? [])
        .filter((parameter) => parameter.in === "query")
        .map((parameter) => parameter.name)
        .sort();
    expect(names(MEMBERS)).toEqual(["page", "pageSize"]);
    expect(names(MEMBERSHIPS)).toEqual(["page", "pageSize", "userIds"]);
    expect(names(LIST)).toEqual(["page", "pageSize", "search"]);
    for (const path of [MEMBERS, MEMBERSHIPS, LIST]) {
      const query = (paths[path]?.get?.parameters ?? []).filter(
        (parameter) => parameter.in === "query",
      );
      expect(query.every((parameter) => parameter.required !== true)).toBe(
        true,
      );
    }
  });

  it("documents page and pageSize on the organization users and group memberships lists", () => {
    // Group memberships also take the userIds filter (like organization
    // memberships); the users list takes the name or RUT search.
    for (const [path, expected] of [
      [USERS, ["page", "pageSize", "search"]],
      [GROUP_MEMBERSHIPS, ["page", "pageSize", "userIds"]],
    ] as const) {
      const query = (paths[path]?.get?.parameters ?? [])
        .filter((parameter) => parameter.in === "query")
        .map((parameter) => parameter.name)
        .sort();
      expect(query, path).toEqual(expected);
      expect(Object.keys(paths[path]!.get!.responses), path).toContain("400");
    }
    const properties = (schema: string) =>
      Object.keys((schemas[schema]?.properties ?? {}) as Json).sort();
    expect(properties("OrganizationUserListResponse")).toEqual([
      "page",
      "pageSize",
      "total",
      "users",
    ]);
    expect(properties("GroupMembershipListResponse")).toEqual([
      "memberships",
      "page",
      "pageSize",
      "total",
    ]);
  });

  it("documents the organization users search as an optional trimmed text of 1..100 characters", () => {
    const search = (paths[USERS]?.get?.parameters ?? []).find(
      (parameter) => parameter.name === "search",
    ) as unknown as {
      required?: boolean;
      schema: { type: string; minLength?: number; maxLength?: number };
      description?: string;
    };
    expect(search.required).not.toBe(true);
    expect(search.schema).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 100,
    });
    expect(search.description).toMatch(/name/i);
    expect(search.description).toMatch(/RUT/);
  });

  it("bounds page to 10000", () => {
    const page = (paths[MEMBERS]?.get?.parameters ?? []).find(
      (parameter) => parameter.name === "page",
    ) as unknown as { schema: { maximum?: number } };
    expect(page.schema.maximum).toBe(10000);
  });

  it("documents a strict request body on the organization PATCH only", () => {
    expect(paths[ORG]?.patch?.requestBody).toBeDefined();
    expect(paths[ORG]?.get?.requestBody).toBeUndefined();
    expect(paths[MEMBERS]?.get?.requestBody).toBeUndefined();
    const body = schemas.OrganizationUpdateRequest as Json | undefined;
    expect(body?.additionalProperties).toBe(false);
    expect(Object.keys((body?.properties ?? {}) as Json).sort()).toEqual([
      "description",
      "name",
    ]);
    expect((body?.required ?? []) as string[]).toEqual([]);
  });

  it("documents the paginated envelopes", () => {
    const properties = (schema: string) =>
      Object.keys((schemas[schema]?.properties ?? {}) as Json).sort();
    expect(properties("OrganizationListResponse")).toEqual([
      "organizations",
      "page",
      "pageSize",
      "total",
    ]);
    expect(properties("MembershipListResponse")).toEqual([
      "memberships",
      "page",
      "pageSize",
      "total",
    ]);
    expect(properties("OrganizationMemberListResponse")).toEqual([
      "members",
      "page",
      "pageSize",
      "total",
    ]);
  });

  it("documents the reduced member item without sensitive fields", () => {
    expect(
      Object.keys(
        (schemas.OrganizationMember?.properties ?? {}) as Json,
      ).sort(),
    ).toEqual(["email", "name", "recentlyActive", "userId"]);
  });

  it("documents disabled and recentlyActive on the membership user summary", () => {
    const properties = (schemas.MembershipUser?.properties ?? {}) as Json;
    expect(Object.keys(properties).sort()).toEqual([
      "disabled",
      "id",
      "name",
      "recentlyActive",
      "rut",
    ]);
  });

  it("documents the basic user response without RUT or disabledAt", () => {
    expect(
      Object.keys((schemas.UserBasicResponse?.properties ?? {}) as Json).sort(),
    ).toEqual(["sharedOrganizations", "user"]);
    expect(
      Object.keys((schemas.UserBasic?.properties ?? {}) as Json).sort(),
    ).toEqual(["email", "id", "name", "recentlyActive"]);
  });

  it("documents ORGANIZATION_UPDATED in the migration and the schema", async () => {
    const { readFile } = await import("node:fs/promises");
    const [schema, migration] = await Promise.all([
      readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../../prisma/migrations/20261028000000_user_status_activity/migration.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    expect(schema).toContain("ORGANIZATION_UPDATED");
    expect(migration).toContain("'ORGANIZATION_UPDATED'");
  });
});
