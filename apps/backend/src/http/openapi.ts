import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";

import { ErrorResponseSchema } from "./errors.js";
import {
  API_PREFIX,
  COMMON_ERROR_RESPONSES,
  LARGE_BODY_PAYLOAD_RESPONSE,
  type Operation,
} from "./registry.js";
import { AuthProfileSchema } from "../features/auth/schemas.js";
import {
  InvoiceCreateRequestSchema,
  InvoiceSchema,
} from "../features/invoices/schemas.js";

const SESSION_SECURITY_SCHEME = "sessionCookie";

/** Generates the OpenAPI 3.1 document from the operation registry. */
export function buildOpenApiDocument(operations: Operation[]) {
  const registry = new OpenAPIRegistry();

  registry.registerComponent("securitySchemes", SESSION_SECURITY_SCHEME, {
    type: "apiKey",
    in: "cookie",
    name: "invoiceops_session",
    description: "HttpOnly web session cookie set by POST /api/v1/auth/login.",
  });

  for (const operation of operations) {
    registry.registerPath({
      method: operation.method,
      path: `${API_PREFIX}${operation.path}`,
      summary: operation.summary,
      tags: [operation.tag],
      security: operation.secured ? [{ [SESSION_SECURITY_SCHEME]: [] }] : [],
      ...(operation.requestBody || operation.params || operation.query
        ? {
            request: {
              ...(operation.params ? { params: operation.params } : {}),
              ...(operation.query ? { query: operation.query } : {}),
              ...(operation.requestBody
                ? {
                    body: {
                      required: true,
                      content: {
                        "application/json": { schema: operation.requestBody },
                      },
                    },
                  }
                : {}),
            },
          }
        : {}),
      responses: Object.fromEntries(
        Object.entries({
          ...COMMON_ERROR_RESPONSES,
          ...(operation.largeBody ? { 413: LARGE_BODY_PAYLOAD_RESPONSE } : {}),
          ...operation.responses,
        }).map(([status, response]) => [
          status,
          {
            description: response.description,
            ...(response.headers
              ? {
                  headers: Object.fromEntries(
                    Object.entries(response.headers).map(([name, header]) => [
                      name,
                      {
                        description: header.description,
                        schema: { type: "string" as const },
                      },
                    ]),
                  ),
                }
              : {}),
            ...(response.schema
              ? {
                  content: {
                    "application/json": { schema: response.schema },
                  },
                }
              : {}),
          },
        ]),
      ),
    });
  }

  // Contracts that exist before their operations do (RP0-11) are published as
  // components only; no invoice operation is documented until it is mounted.
  const generator = new OpenApiGeneratorV31([
    ...registry.definitions,
    { type: "schema", schema: ErrorResponseSchema },
    { type: "schema", schema: AuthProfileSchema },
    { type: "schema", schema: InvoiceCreateRequestSchema },
    { type: "schema", schema: InvoiceSchema },
  ]);

  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "InvoiceOps API",
      version: "0.1.0",
      description: "Local recovery P0 API. Only mounted operations are listed.",
    },
  });
}
