import { beforeAll, describe, expect, it } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";

// Navigated structurally; the document shape is asserted, not typed.
type Json = Record<string, unknown>;

/** Walks nested objects by key, failing loudly when a step is missing. */
function at(root: unknown, ...path: string[]): unknown {
  let current = root;
  for (const key of path) {
    if (typeof current !== "object" || current === null) {
      throw new Error(`Missing OpenAPI node at ${path.join(".")}`);
    }
    current = (current as Json)[key];
  }
  return current;
}

let document: Json;
let operation: Json;

beforeAll(async () => {
  const response = await request(createApp({ isReady: async () => true })).get(
    "/openapi.json",
  );
  document = response.body;
  operation = at(document, "paths", "/api/v1/invoices", "post") as Json;
});

describe("RP0-09/10 POST /api/v1/invoices OpenAPI contract (AC-15)", () => {
  it("is a session-protected operation in the Invoices tag", () => {
    expect(operation.tags).toEqual(["Invoices"]);
    expect(operation.security).toEqual([{ sessionCookie: [] }]);
  });

  it("requires the Idempotency-Key header with the 16..128 key alphabet", () => {
    const header = (operation.parameters as Json[]).find(
      (parameter) => parameter.in === "header",
    );

    expect(header).toMatchObject({
      name: "Idempotency-Key",
      required: true,
      schema: { type: "string", pattern: "^[A-Za-z0-9_-]{16,128}$" },
    });
  });

  it("takes the InvoiceCreateRequest body and answers the InvoiceResponse envelope", () => {
    expect(at(operation, "requestBody", "required")).toBe(true);
    expect(
      at(
        operation,
        "requestBody",
        "content",
        "application/json",
        "schema",
        "$ref",
      ),
    ).toBe("#/components/schemas/InvoiceCreateRequest");
    expect(
      at(
        operation,
        "responses",
        "201",
        "content",
        "application/json",
        "schema",
        "$ref",
      ),
    ).toBe("#/components/schemas/InvoiceResponse");
    expect(
      at(document, "components", "schemas", "InvoiceResponse", "required"),
    ).toEqual(["invoice"]);
  });

  it("documents the Location and Idempotency-Replayed headers of the 201", () => {
    expect(
      Object.keys(at(operation, "responses", "201", "headers") as Json).sort(),
    ).toEqual(["Idempotency-Replayed", "Location"]);
  });

  it("documents every status with the Error envelope", () => {
    for (const status of ["400", "401", "403", "404", "409", "410", "503"]) {
      expect(
        at(
          operation,
          "responses",
          status,
          "content",
          "application/json",
          "schema",
          "$ref",
        ),
        status,
      ).toBe("#/components/schemas/Error");
    }
    const description = (status: string) =>
      at(operation, "responses", status, "description") as string;
    expect(description("409")).toContain("IDEMPOTENCY_CONFLICT");
    expect(description("409")).toContain("BUSINESS_ID_CONFLICT");
    expect(description("410")).toContain("INVOICE_DELETED");
    expect(
      at(operation, "responses", "503", "headers", "Retry-After"),
    ).toBeDefined();
  });

  it("lists the new codes in the Error envelope enum", () => {
    const codes = at(
      document,
      "components",
      "schemas",
      "Error",
      "properties",
      "error",
      "properties",
      "code",
      "enum",
    );

    expect(codes).toEqual(
      expect.arrayContaining([
        "IDEMPOTENCY_CONFLICT",
        "BUSINESS_ID_CONFLICT",
        "INVOICE_DELETED",
      ]),
    );
  });

  it("keeps GET /api/v1/invoices undocumented (owned by RP0-11)", () => {
    expect(at(document, "paths", "/api/v1/invoices", "get")).toBeUndefined();
    expect(
      at(document, "paths", "/api/v1/invoices/{invoiceId}"),
    ).toBeUndefined();
  });
});
