import { beforeAll, describe, expect, it } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import { COMMON_ERROR_RESPONSES } from "../../src/http/registry.js";
import {
  InvoicePageSchema,
  InvoiceResponseSchema,
  InvoiceSchema,
  InvoiceViewResponseSchema,
  InvoiceViewSchema,
} from "../../src/features/invoices/schemas.js";

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

const LIST_PATH = "/api/v1/invoices";
const DETAIL_PATH = "/api/v1/invoices/{invoiceId}";

let document: Json;
let list: Json;
let detail: Json;

beforeAll(async () => {
  const response = await request(createApp({ isReady: async () => true })).get(
    "/openapi.json",
  );
  document = response.body;
  const paths = document.paths as Record<string, Json | undefined>;
  // Undefined until the operations are documented, so each test fails by name.
  list = (paths[LIST_PATH]?.get ?? {}) as Json;
  detail = (paths[DETAIL_PATH]?.get ?? {}) as Json;
});

function parameters(operation: Json, where: string) {
  return ((operation.parameters ?? []) as Json[]).filter(
    (parameter) => parameter.in === where,
  );
}

const names = (items: Json[]) => items.map((item) => String(item.name)).sort();

describe("RP0-11 GET /api/v1/invoices OpenAPI contract", () => {
  it("is a session-protected operation in the Invoices tag", () => {
    expect(Object.keys(list)).not.toHaveLength(0);
    expect(list.tags).toEqual(["Invoices"]);
    expect(list.security).toEqual([{ sessionCookie: [] }]);
  });

  it("documents exactly the new query parameters and none of the legacy ones", () => {
    expect(names(parameters(list, "query"))).toEqual([
      "businessStatus",
      "groupId",
      "issuedFrom",
      "issuedTo",
      "organizationId",
      "page",
      "pageSize",
      "q",
      "ungrouped",
    ]);
  });

  it("requires organizationId only", () => {
    const required = parameters(list, "query")
      .filter((parameter) => parameter.required === true)
      .map((parameter) => parameter.name);

    expect(required).toEqual(["organizationId"]);
  });

  it("documents the closed businessStatus set", () => {
    const status = parameters(list, "query").find(
      (parameter) => parameter.name === "businessStatus",
    );

    expect(at(status, "schema", "enum")).toEqual([
      "PENDING",
      "APPROVED",
      "REJECTED",
      "CANCELLED",
    ]);
  });

  it("answers 200 with the InvoicePage envelope", () => {
    expect(
      at(
        list,
        "responses",
        "200",
        "content",
        "application/json",
        "schema",
        "$ref",
      ),
    ).toBe("#/components/schemas/InvoicePage");
    const page = at(document, "components", "schemas", "InvoicePage") as Json;
    expect(Object.keys(page.properties as Json).sort()).toEqual([
      "items",
      "page",
      "pageSize",
      "total",
    ]);
    expect([...(page.required as string[])].sort()).toEqual([
      "items",
      "page",
      "pageSize",
      "total",
    ]);
    expect(at(page, "properties", "items", "items", "$ref")).toBe(
      "#/components/schemas/InvoiceView",
    );
  });

  it("documents exactly the statuses 200, 400, 401, 403, 404 and 503 plus the common responses (CR-365)", () => {
    const documented = ["200", "400", "401", "403", "404", "503"];
    const common = Object.keys(COMMON_ERROR_RESPONSES);

    expect(Object.keys((list.responses ?? {}) as Json).sort()).toEqual(
      [...documented, ...common].sort(),
    );
  });

  it("documents the error statuses with the Error envelope", () => {
    for (const status of ["400", "401", "403", "404", "503"]) {
      expect(
        at(
          list,
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
});

describe("RP0-11 GET /api/v1/invoices/{invoiceId} OpenAPI contract", () => {
  it("is a session-protected operation in the Invoices tag", () => {
    expect(Object.keys(detail)).not.toHaveLength(0);
    expect(detail.tags).toEqual(["Invoices"]);
    expect(detail.security).toEqual([{ sessionCookie: [] }]);
  });

  it("documents the invoiceId path parameter and the organizationId and groupId query", () => {
    expect(names(parameters(detail, "path"))).toEqual(["invoiceId"]);
    expect(names(parameters(detail, "query"))).toEqual([
      "groupId",
      "organizationId",
    ]);
    const required = parameters(detail, "query")
      .filter((parameter) => parameter.required === true)
      .map((parameter) => parameter.name);
    expect(required).toEqual(["organizationId"]);
  });

  it("answers 200 with the InvoiceViewResponse envelope", () => {
    expect(
      at(
        detail,
        "responses",
        "200",
        "content",
        "application/json",
        "schema",
        "$ref",
      ),
    ).toBe("#/components/schemas/InvoiceViewResponse");
  });

  it("documents exactly the statuses 200, 400, 401, 403, 404 and 503 plus the common responses (CR-365)", () => {
    const documented = ["200", "400", "401", "403", "404", "503"];
    const common = Object.keys(COMMON_ERROR_RESPONSES);

    expect(Object.keys((detail.responses ?? {}) as Json).sort()).toEqual(
      [...documented, ...common].sort(),
    );
  });

  it("documents the error statuses with the Error envelope", () => {
    for (const status of ["400", "401", "403", "404", "503"]) {
      expect(
        at(
          detail,
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
});

describe("InvoiceView read DTO and unchanged create contract", () => {
  const schemas = () => at(document, "components", "schemas") as Json;

  it("publishes InvoiceView as Invoice plus a required nullable groupName", () => {
    const view = schemas().InvoiceView as Json;
    const properties = view.properties as Json;

    expect(Object.keys(properties).sort()).toEqual(
      [...Object.keys(InvoiceSchema.shape), "groupName"].sort(),
    );
    expect(view.required as string[]).toContain("groupName");
    expect(JSON.stringify(properties.groupName)).toContain("null");
  });

  it("keeps Invoice and the create response free of groupName", () => {
    const invoice = schemas().Invoice as Json;
    expect(Object.keys(invoice.properties as Json)).not.toContain("groupName");

    const paths = document.paths as Record<string, Json | undefined>;
    expect(
      at(
        paths[LIST_PATH],
        "post",
        "responses",
        "201",
        "content",
        "application/json",
        "schema",
        "$ref",
      ),
    ).toBe("#/components/schemas/InvoiceResponse");
  });
});

describe("RP0-11 documented examples", () => {
  const examplesOf = (schema: string) => {
    const node = at(document, "components", "schemas", schema) as Json;
    return Array.isArray(node.examples) ? node.examples : [];
  };

  it("keeps at least one Invoice example and validates every Invoice example", () => {
    const examples = examplesOf("Invoice");

    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(InvoiceSchema.safeParse(example).success).toBe(true);
    }
  });

  it("validates every InvoicePage example with InvoicePageSchema", () => {
    for (const example of examplesOf("InvoicePage")) {
      expect(InvoicePageSchema.safeParse(example).success).toBe(true);
    }
  });

  it("validates every InvoiceView and InvoiceViewResponse example", () => {
    const views = examplesOf("InvoiceView");
    expect(views.length).toBeGreaterThan(0);
    for (const example of views) {
      expect(InvoiceViewSchema.safeParse(example).success).toBe(true);
    }
    for (const example of examplesOf("InvoiceViewResponse")) {
      expect(InvoiceViewResponseSchema.safeParse(example).success).toBe(true);
    }
  });

  it("validates every InvoiceResponse example with InvoiceResponseSchema", () => {
    for (const example of examplesOf("InvoiceResponse")) {
      expect(InvoiceResponseSchema.safeParse(example).success).toBe(true);
    }
  });
});
