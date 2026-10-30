import { beforeAll, describe, expect, it } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import { COMMON_ERROR_RESPONSES } from "../../src/http/registry.js";

// Navigated structurally; the document shape is asserted, not typed.
type Json = Record<string, unknown>;

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

const DETAIL_PATH = "/api/v1/invoices/{invoiceId}";

let operation: Json;

beforeAll(async () => {
  const response = await request(createApp({ isReady: async () => true })).get(
    "/openapi.json",
  );
  const paths = response.body.paths as Record<string, Json | undefined>;
  // Empty until the operation is documented, so each test fails by name.
  operation = (paths[DETAIL_PATH]?.delete ?? {}) as Json;
});

function parameters(where: string) {
  return ((operation.parameters ?? []) as Json[]).filter(
    (parameter) => parameter.in === where,
  );
}

const names = (items: Json[]) => items.map((item) => String(item.name)).sort();

describe("RP0-12 DELETE /api/v1/invoices/{invoiceId} OpenAPI contract", () => {
  it("is a session-protected operation in the Invoices tag", () => {
    expect(Object.keys(operation)).not.toHaveLength(0);
    expect(operation.tags).toEqual(["Invoices"]);
    expect(operation.security).toEqual([{ sessionCookie: [] }]);
  });

  it("documents the invoiceId path parameter and the organizationId and groupId query", () => {
    expect(names(parameters("path"))).toEqual(["invoiceId"]);
    expect(names(parameters("query"))).toEqual(["groupId", "organizationId"]);
    const required = parameters("query")
      .filter((parameter) => parameter.required === true)
      .map((parameter) => parameter.name);
    expect(required).toEqual(["organizationId"]);
  });

  it("documents exactly the statuses 204, 400, 401, 403, 404 and 503 plus the common responses", () => {
    const documented = ["204", "400", "401", "403", "404", "503"];
    const common = Object.keys(COMMON_ERROR_RESPONSES);

    expect(Object.keys((operation.responses ?? {}) as Json).sort()).toEqual(
      [...documented, ...common].sort(),
    );
  });

  it("documents the invoiceId path parameter as a uuid", () => {
    const [parameter] = parameters("path");

    expect(at(parameter, "schema", "format")).toBe("uuid");
  });

  it("answers 204 without a body", () => {
    const response = at(operation, "responses", "204") as Json;

    expect(response.content).toBeUndefined();
    expect(String(response.description)).not.toHaveLength(0);
  });

  it("documents the error statuses with the Error envelope", () => {
    for (const status of ["400", "401", "403", "404", "503"]) {
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
  });

  it("documents RETRYABLE_CONFLICT with a Retry-After header on 503", () => {
    const response = at(operation, "responses", "503") as Json;

    expect(String(response.description)).toContain("RETRYABLE_CONFLICT");
    expect(Object.keys((response.headers ?? {}) as Json)).toContain(
      "Retry-After",
    );
  });

  it("explains that read and create are not required and that deletion is idempotent", () => {
    const text = JSON.stringify(operation);

    expect(text).toMatch(/deleteOwnInvoices/);
    expect(text).toMatch(/deleteOthersInvoices/);
    expect(String((operation.summary ?? "") as string)).not.toHaveLength(0);
  });
});
