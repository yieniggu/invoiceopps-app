import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import request from "../support/request.js";
import { createApp } from "../../src/app.js";
import { ApiTokenCreateRequestSchema } from "../../src/features/api-tokens/schemas.js";

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

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const BEARER_OPERATIONS = [
  ["/api/v1/invoices", "post"],
  ["/api/v1/invoices", "get"],
  ["/api/v1/invoices/{invoiceId}", "get"],
  ["/api/v1/invoices/{invoiceId}", "delete"],
] as const;
const TOKENS_PATH = "/api/v1/api-tokens";
const TOKEN_PATH = "/api/v1/api-tokens/{tokenId}";

let document: Json;

/** Resolves a local `$ref` (one level) against the document. */
function resolve(node: unknown): Json {
  const ref = (node as Json | undefined)?.$ref;
  if (typeof ref !== "string") return node as Json;
  return at(document, ...ref.replace(/^#\//, "").split("/")) as Json;
}

const schemaOf = (operation: unknown, status: string) =>
  resolve(
    at(operation, "responses", status, "content", "application/json", "schema"),
  );

beforeAll(async () => {
  const response = await request(createApp({ isReady: async () => true })).get(
    "/openapi.json",
  );
  document = response.body;
});

describe("RP0-16 security schemes (AC-08)", () => {
  it("declares bearerAuth as an HTTP bearer scheme next to sessionCookie", () => {
    expect(
      at(document, "components", "securitySchemes", "bearerAuth"),
    ).toMatchObject({ type: "http", scheme: "bearer" });
    expect(
      at(document, "components", "securitySchemes", "sessionCookie"),
    ).toBeDefined();
  });

  it.each(BEARER_OPERATIONS)(
    "offers sessionCookie OR bearerAuth on %s %s",
    (path, method) => {
      const security = at(document, "paths", path, method, "security");

      expect(security).toEqual([{ sessionCookie: [] }, { bearerAuth: [] }]);
    },
  );

  it("keeps every other secured operation session-only", () => {
    const allowed = new Set(
      BEARER_OPERATIONS.map(([path, method]) => `${method} ${path}`),
    );
    const checked: string[] = [];
    for (const [path, item] of Object.entries(
      at(document, "paths") as Record<string, Json>,
    )) {
      for (const method of HTTP_METHODS) {
        const operation = item[method] as Json | undefined;
        const security = operation?.security as unknown[] | undefined;
        if (!operation || !security || security.length === 0) continue;
        if (allowed.has(`${method} ${path}`)) continue;
        checked.push(`${method} ${path}`);
        expect(security, `${method} ${path}`).toEqual([{ sessionCookie: [] }]);
      }
    }
    expect(checked).toEqual(
      expect.arrayContaining([
        `post ${TOKENS_PATH}`,
        `get ${TOKENS_PATH}`,
        `delete ${TOKEN_PATH}`,
      ]),
    );
  });
});

describe("RP0-16 /api/v1/api-tokens paths (AC-06, AC-11)", () => {
  it("documents POST with the 201 envelope and no-store", () => {
    const operation = at(document, "paths", TOKENS_PATH, "post");

    expect(
      at(operation, "responses", "201", "headers", "Cache-Control"),
    ).toBeDefined();
    const created = schemaOf(operation, "201");
    expect(created.required).toEqual(
      expect.arrayContaining(["token", "secret"]),
    );
    for (const status of ["400", "401", "403", "404"]) {
      expect(schemaOf(operation, status), status).toMatchObject({
        properties: { error: expect.anything() },
      });
    }
  });

  it("documents POST 409 TOKEN_LIMIT and 429 RATE_LIMITED (CR-341)", () => {
    const operation = at(document, "paths", TOKENS_PATH, "post");
    const description = (status: string) =>
      at(operation, "responses", status, "description") as string;

    for (const status of ["409", "429"]) {
      expect(schemaOf(operation, status), status).toMatchObject({
        properties: { error: expect.anything() },
      });
    }
    expect(description("409")).toContain("TOKEN_LIMIT");
    expect(description("429")).toContain("RATE_LIMITED");
  });

  it("requires expiresAt, scopes and organizationId in the creation body", () => {
    const operation = at(document, "paths", TOKENS_PATH, "post");
    const body = resolve(
      at(operation, "requestBody", "content", "application/json", "schema"),
    );

    expect(body.required).toEqual(
      expect.arrayContaining(["name", "organizationId", "scopes", "expiresAt"]),
    );
    expect(body.required).not.toContain("groupId");
  });

  it("documents GET as a page of token metadata", () => {
    const operation = at(document, "paths", TOKENS_PATH, "get");
    const names = (at(operation, "parameters") as Json[]).map((p) => p.name);

    expect(names).toEqual(
      expect.arrayContaining(["organizationId", "groupId", "page", "pageSize"]),
    );
    expect(schemaOf(operation, "200").required).toEqual(
      expect.arrayContaining(["items", "page", "pageSize", "total"]),
    );
    for (const status of ["400", "401"]) {
      expect(at(operation, "responses", status), status).toBeDefined();
    }
  });

  it("documents DELETE with 204, 401 and 404", () => {
    const operation = at(document, "paths", TOKEN_PATH, "delete");

    for (const status of ["204", "401", "404"]) {
      expect(at(operation, "responses", status), status).toBeDefined();
    }
  });

  it("never describes a tokenHash anywhere in the document", () => {
    expect(JSON.stringify(document)).not.toContain("tokenHash");
  });
});

describe("RP0-16 INSUFFICIENT_SCOPE (AC-09)", () => {
  it("is part of the Error code enum", () => {
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

    expect(codes).toEqual(expect.arrayContaining(["INSUFFICIENT_SCOPE"]));
  });

  it.each(BEARER_OPERATIONS)(
    "is documented on the 403 of %s %s",
    (path, method) => {
      const description = at(
        document,
        "paths",
        path,
        method,
        "responses",
        "403",
        "description",
      ) as string;

      expect(description).toContain("INSUFFICIENT_SCOPE");
    },
  );

  it("documents 401 on the Bearer-capable invoice operations", () => {
    for (const [path, method] of BEARER_OPERATIONS) {
      expect(
        at(document, "paths", path, method, "responses", "401"),
        `${method} ${path}`,
      ).toBeDefined();
    }
  });
});

describe("CR-325 the token-create example never goes stale", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function exampleAt(now: Date) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const response = await request(
      createApp({ isReady: async () => true }),
    ).get("/openapi.json");
    const examples = at(
      response.body,
      "components",
      "schemas",
      "ApiTokenCreateRequest",
      "examples",
    ) as unknown[];
    return examples[0];
  }

  it.each(["2026-10-31T12:00:00.000Z", "2027-06-01T08:30:00.000Z"])(
    "parses with the real request schema when the spec is built at %s",
    async (iso) => {
      const now = new Date(iso);
      const example = await exampleAt(now);

      const parsed = ApiTokenCreateRequestSchema.parse(example);

      expect(new Date(parsed.expiresAt).getTime() - now.getTime()).toBe(
        7 * 24 * 60 * 60 * 1000,
      );
    },
  );
});
