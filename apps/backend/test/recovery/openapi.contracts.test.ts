import { createRequire } from "node:module";

import { Validator } from "@seriousme/openapi-schema-validator";
import express from "express";
import request from "../support/request.js";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import {
  compareRouteParity,
  enumerateMountedRoutes,
  enumerateOpenApiRoutes,
  routeKey,
} from "./route-parity.js";

type Json = Record<string, unknown>;

const README_INVOICE_SAMPLE = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  groupId: "22222222-2222-4222-8222-222222222222",
  businessId: "FAC-2026-001",
  supplierName: "Proveedor local",
  amountPesos: 12500,
  currency: "CLP",
  issuedOn: "2026-10-25",
  dueOn: "2026-11-25",
  businessStatus: "PENDING",
};

const AUTH_OPERATIONS = [
  ["/api/v1/auth/login", "post"],
  ["/api/v1/auth/profile", "get"],
  ["/api/v1/auth/change-password", "post"],
  ["/api/v1/auth/logout", "post"],
] as const;

function buildApp() {
  return createApp({ isReady: async () => true });
}

async function fetchDocument(): Promise<Json> {
  const response = await request(buildApp()).get("/openapi.json");
  expect(response.status).toBe(200);
  return response.body as Json;
}

// ajv and ajv-formats are transitive dependencies of the OpenAPI validator
// (no extra devDependency): they are loaded from the validator's own location.
function createSchemaChecker() {
  const fromValidator = createRequire(
    createRequire(import.meta.url).resolve(
      "@seriousme/openapi-schema-validator",
    ),
  );
  const Ajv2020 = fromValidator("ajv/dist/2020").default;
  const addFormats = fromValidator("ajv-formats").default;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return (schema: object, value: unknown): string[] => {
    const validate = ajv.compile(schema);
    return validate(value)
      ? []
      : (validate.errors ?? []).map(
          (error: { instancePath: string; message?: string }) =>
            `${error.instancePath || "/"} ${error.message}`,
        );
  };
}

// Collects every example attached to a schema, media type or parameter.
function collectExamples(
  node: unknown,
  location: string,
  found: Array<{ location: string; schema: object; value: unknown }>,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) =>
      collectExamples(item, `${location}[${index}]`, found),
    );
    return;
  }
  if (node === null || typeof node !== "object") return;
  const object = node as Json;

  if (typeof object.type === "string" || object.properties !== undefined) {
    // JSON Schema object: `example` (deprecated) and `examples` (array).
    if ("example" in object) {
      found.push({
        location: `${location}.example`,
        schema: object,
        value: object.example,
      });
    }
    if (Array.isArray(object.examples)) {
      object.examples.forEach((value, index) =>
        found.push({
          location: `${location}.examples[${index}]`,
          schema: object,
          value,
        }),
      );
    }
  } else if (typeof object.schema === "object" && object.schema !== null) {
    // Media type / parameter object.
    if ("example" in object) {
      found.push({
        location: `${location}.example`,
        schema: object.schema,
        value: object.example,
      });
    }
    if (object.examples && typeof object.examples === "object") {
      for (const [name, example] of Object.entries(object.examples)) {
        found.push({
          location: `${location}.examples.${name}`,
          schema: object.schema,
          value: (example as Json).value,
        });
      }
    }
  }

  for (const [key, child] of Object.entries(object)) {
    collectExamples(child, `${location}.${key}`, found);
  }
}

describe("RP0 OpenAPI document contract", () => {
  let document: Json;
  let schemas: Record<string, Json>;

  // Deliberately lenient: while /openapi.json is missing every test below must
  // fail on its own assertion instead of one setup error hiding them all.
  beforeAll(async () => {
    const response = await request(buildApp()).get("/openapi.json");
    document = (response.status === 200 ? response.body : {}) as Json;
    schemas = ((document.components as Json | undefined)?.schemas ??
      {}) as Record<string, Json>;
  });

  it("serves GET /openapi.json publicly without secrets", async () => {
    const response = await request(buildApp()).get("/openapi.json");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.headers["set-cookie"]).toBeUndefined();
    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(/DATABASE_URL|postgres(ql)?:\/\//i);
    expect(text).not.toMatch(/invoiceops_session=[^"\s]+/);
  });

  it("declares OpenAPI 3.1.x and passes the offline schema validator", async () => {
    expect(document.openapi).toMatch(/^3\.1\.\d+$/);

    const validator = new Validator();
    const result = await validator.validate(document);

    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(validator.version).toBe("3.1");
  });

  it("documents exactly the mounted auth operations and no invoice creation", () => {
    const documented = enumerateOpenApiRoutes(document).map((route) =>
      routeKey(route.method, route.path),
    );

    expect(documented.sort()).toEqual(
      AUTH_OPERATIONS.map(([path, method]) => routeKey(method, path)).sort(),
    );
    const paths = document.paths as Record<string, Json>;
    expect(paths["/api/v1/invoices"]?.post).toBeUndefined();
  });

  it("defines the Error envelope, AuthProfile, InvoiceCreateRequest and Invoice schemas", () => {
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        "Error",
        "AuthProfile",
        "InvoiceCreateRequest",
        "Invoice",
      ]),
    );

    const errorSchema = schemas.Error as Json;
    const errorProperties = errorSchema.properties as Record<string, Json>;
    expect(errorSchema.required).toEqual(["error"]);
    const inner = errorProperties.error as Json;
    expect(inner.required).toEqual(expect.arrayContaining(["code", "message"]));
    expect(inner.required).not.toContain("fields");
    expect(Object.keys(inner.properties as Json).sort()).toEqual([
      "code",
      "fields",
      "message",
    ]);

    const profile = (schemas.AuthProfile.properties as Record<string, Json>)
      .mustChangePassword;
    expect(profile?.type).toBe("boolean");
  });

  it("defines Invoice and InvoiceCreateRequest per the P0 money table", () => {
    expect(schemas.Invoice).toBeDefined();
    expect(schemas.InvoiceCreateRequest).toBeDefined();
    const invoice = schemas.Invoice.properties as Record<string, Json>;
    const create = schemas.InvoiceCreateRequest;
    const createProperties = create.properties as Record<string, Json>;

    expect(invoice.id).toMatchObject({ type: "string", format: "uuid" });
    for (const field of [
      "businessId",
      "organizationId",
      "groupId",
      "supplierName",
      "createdByUserId",
    ]) {
      expect(invoice[field]?.type).toBe("string");
    }
    for (const model of [invoice, createProperties]) {
      expect(model.amountPesos).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: 2147483647,
      });
      expect(model.currency?.enum).toEqual(["CLP"]);
      expect(model.issuedOn).toMatchObject({ format: "date" });
      expect(model.dueOn).toMatchObject({ format: "date" });
      expect(model.businessStatus?.enum).toEqual([
        "PENDING",
        "APPROVED",
        "REJECTED",
        "CANCELLED",
      ]);
    }
    expect(invoice.processingStatus?.enum).toEqual(["NOT_REQUESTED"]);
    expect(invoice.createdAt).toBeDefined();

    expect(create.additionalProperties).toBe(false);
    for (const serverOnly of [
      "processingStatus",
      "createdByUserId",
      "id",
      "createdAt",
    ]) {
      expect(createProperties).not.toHaveProperty(serverOnly);
    }
  });

  it("carries the README sample as an InvoiceCreateRequest example", () => {
    expect(schemas.InvoiceCreateRequest).toBeDefined();
    const create = schemas.InvoiceCreateRequest;
    const examples = [
      ...(Array.isArray(create.examples) ? create.examples : []),
      ...("example" in create ? [create.example] : []),
    ];

    expect(examples).toContainEqual(README_INVOICE_SAMPLE);
  });

  it("validates every example in components and operations against its schema", async () => {
    const validator = new Validator();
    await validator.validate(document);
    const resolved = validator.resolveRefs() as Json;
    const check = createSchemaChecker();

    const found: Array<{ location: string; schema: object; value: unknown }> =
      [];
    collectExamples(resolved.components, "components", found);
    collectExamples(resolved.paths, "paths", found);

    // Guards against vacuous success: at least the README sample exists.
    expect(found.length).toBeGreaterThan(0);
    const failures = found.flatMap(({ location, schema, value }) =>
      check(schema, value).map((message) => `${location}: ${message}`),
    );
    expect(failures).toEqual([]);
  });
});

// Loaded lazily so the OpenAPI tests above report their own failures while
// src/http/registry.ts does not exist yet.
async function loadLegacyRoutes() {
  const { LEGACY_ROUTES } = await import("../../src/http/registry.js");
  return LEGACY_ROUTES;
}

describe("RP0 route parity", () => {
  async function documentedRoutes() {
    return enumerateOpenApiRoutes(await fetchDocument());
  }

  it("keeps mounted routes and documented/legacy routes in parity", async () => {
    const result = compareRouteParity({
      mounted: enumerateMountedRoutes(buildApp()),
      documented: await documentedRoutes(),
      legacy: await loadLegacyRoutes(),
    });

    expect(result).toEqual({ undocumented: [], phantom: [] });
  });

  it("flags a ghost route added after createApp as undocumented (induced failure)", async () => {
    const app = buildApp();
    (app as express.Express).post("/api/v1/ghost", (_request, response) => {
      response.status(204).end();
    });

    const result = compareRouteParity({
      mounted: enumerateMountedRoutes(app),
      documented: await documentedRoutes(),
      legacy: await loadLegacyRoutes(),
    });

    expect(result.undocumented).toContain("POST /api/v1/ghost");
  });

  it("flags a documented path that is not mounted as phantom (induced failure)", async () => {
    const result = compareRouteParity({
      mounted: enumerateMountedRoutes(buildApp()),
      documented: [
        ...(await documentedRoutes()),
        { method: "GET", path: "/api/v1/phantom/{id}" },
      ],
      legacy: await loadLegacyRoutes(),
    });

    expect(result.phantom).toContain("GET /api/v1/phantom/{id}");
  });

  it("owns every legacy route by an RP0 ticket (or LEGACY-NO-P0) and never documents it twice", async () => {
    const LEGACY_ROUTES = await loadLegacyRoutes();
    expect(LEGACY_ROUTES.length).toBeGreaterThan(0);
    for (const route of LEGACY_ROUTES) {
      // LEGACY-NO-P0: routes no P0 ticket will reshape (backlog CR-019).
      expect(route.owner).toMatch(/^(RP0-\d{2}|LEGACY-NO-P0)$/);
    }

    const documented = new Set(
      (await documentedRoutes()).map((route) =>
        routeKey(route.method, route.path),
      ),
    );
    const overlap = LEGACY_ROUTES.map((route) =>
      routeKey(route.method, route.path),
    ).filter((key) => documented.has(key));
    expect(overlap).toEqual([]);
  });
});
