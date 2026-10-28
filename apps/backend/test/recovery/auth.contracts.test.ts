import request from "../support/request.js";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";

type Json = Record<string, unknown>;

async function documentation() {
  const response = await request(createApp({ isReady: async () => true })).get(
    "/openapi.json",
  );
  expect(response.status).toBe(200);
  return response.body as Json;
}

describe("RP0-04 auth OpenAPI contract", () => {
  it("lists the auth error codes in the Error schema", async () => {
    const schemas = ((await documentation()).components as Json)
      .schemas as Record<string, Json>;
    const error = (schemas.Error.properties as Record<string, Json>)
      .error as Json;
    const code = (error.properties as Record<string, Json>).code;

    expect(code.enum).toEqual(
      expect.arrayContaining([
        "AMBIGUOUS_AUTH",
        "PASSWORD_REUSE",
        "ONBOARDING_REQUIRED",
        "UNAUTHENTICATED",
        "FORBIDDEN_ORIGIN",
        "RATE_LIMITED",
      ]),
    );
  });

  it("documents memberships with permissions and groups, and no contexts, in AuthProfile", async () => {
    const schemas = ((await documentation()).components as Json)
      .schemas as Record<string, Json>;
    const profile = schemas.AuthProfile;
    const properties = profile.properties as Record<string, Json>;

    expect(profile.required).not.toContain("contexts");
    expect(properties.contexts).toBeUndefined();
    expect(profile.required).toEqual(
      expect.arrayContaining(["memberships", "isPlatformAdministrator"]),
    );
    const membership = properties.memberships.items as Json;
    expect(Object.keys(membership.properties as Json).sort()).toEqual([
      "groups",
      "organization",
      "permissions",
      "role",
    ]);
    const group = (
      (membership.properties as Record<string, Json>).groups as Json
    ).items as Json;
    expect(Object.keys(group.properties as Json).sort()).toEqual([
      "effective",
      "group",
      "permissions",
    ]);
    for (const holder of [
      (membership.properties as Record<string, Json>).permissions,
      (group.properties as Record<string, Json>).permissions,
      (group.properties as Record<string, Json>).effective,
    ]) {
      expect(holder.additionalProperties).toBe(false);
      expect(Object.keys(holder.properties as Json).sort()).toEqual([
        "createInvoices",
        "deleteOthersInvoices",
        "deleteOwnInvoices",
        "readInvoices",
      ]);
    }
  });

  it("documents the rotated cookie and PASSWORD_REUSE on change-password", async () => {
    const paths = (await documentation()).paths as Record<string, Json>;
    const operation = (paths["/api/v1/auth/change-password"] as Json)
      .post as Json;
    const responses = operation.responses as Record<string, Json>;

    expect(Object.keys(responses)).toEqual(
      expect.arrayContaining(["204", "400", "401", "403"]),
    );
    expect(
      (responses["204"].headers as Record<string, Json> | undefined)?.[
        "Set-Cookie"
      ],
    ).toBeDefined();
    expect(String(responses["400"].description)).toContain("PASSWORD_REUSE");
  });

  it("documents AMBIGUOUS_AUTH on every auth operation", async () => {
    const paths = (await documentation()).paths as Record<string, Json>;
    for (const [path, method] of [
      ["/api/v1/auth/login", "post"],
      ["/api/v1/auth/profile", "get"],
      ["/api/v1/auth/change-password", "post"],
      ["/api/v1/auth/logout", "post"],
    ] as const) {
      const responses = ((paths[path] as Json)[method] as Json)
        .responses as Record<string, Json>;
      expect(String(responses["400"]?.description), path).toContain(
        "AMBIGUOUS_AUTH",
      );
    }
  });
});
