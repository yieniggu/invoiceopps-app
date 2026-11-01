import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import {
  IdempotencyKeySchema,
  InvoiceCreateRequestSchema,
} from "../../src/features/invoices/schemas.js";
import request from "../support/request.js";

type Json = Record<string, unknown>;

const INVOICE_OPERATIONS = [
  ["/api/v1/invoices", "get"],
  ["/api/v1/invoices", "post"],
  ["/api/v1/invoices/{invoiceId}", "get"],
  ["/api/v1/invoices/{invoiceId}", "delete"],
];

describe("AC-16 OpenAPI documentation for the Swagger UI", () => {
  let document: Json;

  beforeAll(async () => {
    const response = await request(
      createApp({ isReady: async () => true }),
    ).get("/openapi.json");
    document = response.body as Json;
  });

  function operationsOf() {
    const paths = document.paths as Record<string, Record<string, Json>>;
    return Object.entries(paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => ({
        path,
        method,
        operation,
      })),
    );
  }

  it("lists bearerAuth on exactly the four invoice operations", () => {
    const withBearer = operationsOf()
      .filter(({ operation }) =>
        (operation.security as Json[]).some((entry) => "bearerAuth" in entry),
      )
      .map(({ path, method }) => [path, method]);

    expect(withBearer.sort()).toEqual([...INVOICE_OPERATIONS].sort());
  });

  it("declares a top-level tag with a description for every tag an operation uses", () => {
    const tags = document.tags as Array<{ name: string; description: string }>;
    expect(tags).toBeDefined();
    const declared = tags.map((tag) => tag.name);
    expect(new Set(declared).size).toBe(declared.length);
    for (const tag of tags) expect(tag.description.length).toBeGreaterThan(10);

    const used = new Set(
      operationsOf().flatMap(({ operation }) => operation.tags as string[]),
    );
    expect([...used].sort()).toEqual([...declared].sort());
    expect(declared).toEqual(
      expect.arrayContaining([
        "Auth",
        "Organizations",
        "Groups",
        "Users",
        "Admin users",
        "Invoices",
        "API tokens",
      ]),
    );
  });

  describe("POST /api/v1/invoices examples", () => {
    function createOperation() {
      const paths = document.paths as Record<string, Record<string, Json>>;
      return paths["/api/v1/invoices"].post;
    }

    function bodyExamples() {
      const content = (createOperation().requestBody as Json).content as Record<
        string,
        Json
      >;
      return (content["application/json"].examples ?? {}) as Record<
        string,
        { summary?: string; value: unknown }
      >;
    }

    it("offers an organization-scope and a group-scope request example", () => {
      const examples = Object.values(bodyExamples());

      expect(examples.length).toBeGreaterThanOrEqual(2);
      const values = examples.map((example) => example.value as Json);
      const organization = values.filter((value) => !("groupId" in value));
      const group = values.filter((value) => typeof value.groupId === "string");
      expect(organization.length).toBeGreaterThanOrEqual(1);
      expect(group.length).toBeGreaterThanOrEqual(1);
      for (const example of examples) {
        expect(example.summary?.length).toBeGreaterThan(5);
      }
    });

    it("parses every example through the request schema with integer CLP pesos and ISO dates", () => {
      const examples = Object.entries(bodyExamples());
      expect(examples.length).toBeGreaterThanOrEqual(2);

      for (const [name, example] of examples) {
        const parsed = InvoiceCreateRequestSchema.safeParse(example.value);
        expect(parsed.error?.issues, name).toBeUndefined();
        const value = example.value as Json;
        expect(Number.isInteger(value.amountPesos), name).toBe(true);
        expect(value.currency, name).toBe("CLP");
        expect(value.issuedOn, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(value.dueOn, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it("documents the Idempotency-Key header with an example the schema accepts", () => {
      const parameters = createOperation().parameters as Array<
        Json & { schema?: Json }
      >;
      const header = parameters.find(
        (parameter) =>
          parameter.in === "header" && parameter.name === "Idempotency-Key",
      );

      expect(header).toBeDefined();
      expect(header?.required).toBe(true);
      const examples = [
        ...((header?.schema?.examples as unknown[] | undefined) ?? []),
        ...("example" in (header ?? {}) ? [header?.example] : []),
      ];
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) {
        expect(IdempotencyKeySchema.safeParse(example).success).toBe(true);
      }
    });
  });
});
