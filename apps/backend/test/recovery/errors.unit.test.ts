import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ApiError,
  ERROR_CODES,
  parseWith,
  sendError,
} from "../../src/http/errors.js";

function failure(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("expected the parse to fail");
}

describe("validation error fields", () => {
  const schema = z.object({ name: z.string() }).strict();

  it("keeps a __proto__ key from the request as an own property", () => {
    const error = failure(() =>
      parseWith(
        schema,
        JSON.parse('{"name":"a","__proto__":1,"constructor":2}'),
      ),
    );

    expect(Object.getPrototypeOf(error.fields)).toBeNull();
    expect(Object.hasOwn(error.fields!, "__proto__")).toBe(true);
    expect(error.fields).toMatchObject({ constructor: "Unknown field" });
    expect(Object.keys(error.fields!).sort()).toEqual([
      "__proto__",
      "constructor",
    ]);
  });

  it("serializes a __proto__ field into the response body", () => {
    const error = failure(() =>
      parseWith(schema, JSON.parse('{"name":"a","__proto__":1}')),
    );
    let sent = "";
    const response = {
      status: () => response,
      json: (body: unknown) => {
        sent = JSON.stringify(body);
      },
    };

    sendError(
      response as never,
      error.status,
      error.code,
      error.message,
      error.fields,
    );

    expect(sent).toContain('"__proto__":"Unknown field"');
  });

  it("reports nested paths and default messages", () => {
    const error = failure(() =>
      parseWith(z.object({ a: z.object({ b: z.string() }) }), { a: { b: 1 } }),
    );

    expect(error.fields).toEqual({
      "a.b": "Invalid input: expected string, received number",
    });
    expect(error.message).toBe("Invalid request");
  });

  it("keeps the first message when two issues share a field", () => {
    const error = failure(() =>
      parseWith(z.object({ a: z.string().min(5).regex(/^\d+$/) }), { a: "x" }),
    );

    expect(Object.keys(error.fields!)).toEqual(["a"]);
  });
});

describe("B3c S1 error codes", () => {
  it("declares the user deactivation conflict codes", () => {
    expect(ERROR_CODES).toEqual(
      expect.arrayContaining(["SELF_ACTION_FORBIDDEN", "LAST_ADMIN_REQUIRED"]),
    );
  });

  // The platform administrator is the only allowed actor, so targeting them
  // is always a self action; a dedicated code would be unreachable.
  it("does not declare an unreachable platform administrator code", () => {
    expect(ERROR_CODES).not.toContain("PLATFORM_ADMINISTRATOR_PROTECTED");
  });
});

describe("B4 invoice creation error codes", () => {
  it("declares the idempotency, businessId and deleted-invoice codes", () => {
    expect(ERROR_CODES).toEqual(
      expect.arrayContaining([
        "IDEMPOTENCY_CONFLICT",
        "BUSINESS_ID_CONFLICT",
        "INVOICE_DELETED",
      ]),
    );
  });
});
