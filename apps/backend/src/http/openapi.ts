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
  InvoiceViewSchema,
} from "../features/invoices/schemas.js";

const SESSION_SECURITY_SCHEME = "sessionCookie";
const BEARER_SECURITY_SCHEME = "bearerAuth";

/**
 * Top-level tags, in the order Swagger UI lists them. Every operation tag
 * must be declared here (a contract test enforces it).
 */
const TAGS = [
  {
    name: "Auth",
    description: "Sign in with the web session cookie and manage the profile.",
  },
  {
    name: "Organizations",
    description: "Organizations and their members (platform administrator).",
  },
  {
    name: "Groups",
    description: "Groups inside an organization and their members.",
  },
  {
    name: "Users",
    description: "People visible to the caller inside an organization.",
  },
  {
    name: "Admin users",
    description:
      "User provisioning and directory for the platform administrator.",
  },
  {
    name: "Invoices",
    description:
      "Create, list, read and delete invoices. These are the only operations that also accept an API token (bearerAuth).",
  },
  {
    name: "API tokens",
    description:
      "Emit, list and revoke operational API tokens (web session only). The secret is shown once.",
  },
  {
    name: "Models",
    description:
      "Registered MLflow models of a context and their deployments with the official gate (web session only; off until the organization enables mlEnabled).",
  },
  {
    name: "MLflow",
    description:
      "Browser leg of the MLflow sign-in handoff (web session cookie): redirects to the gateway callback with a single-use code.",
  },
];

/** Generates the OpenAPI 3.1 document from the operation registry. */
export function buildOpenApiDocument(operations: Operation[]) {
  const registry = new OpenAPIRegistry();

  registry.registerComponent("securitySchemes", SESSION_SECURITY_SCHEME, {
    type: "apiKey",
    in: "cookie",
    name: "invoiceops_session",
    description: "HttpOnly web session cookie set by POST /api/v1/auth/login.",
  });

  registry.registerComponent("securitySchemes", BEARER_SECURITY_SCHEME, {
    type: "http",
    scheme: "bearer",
    description:
      "Operational API token (iop_ prefix) emitted by POST /api/v1/api-tokens. Accepted only by the invoice operations that list it; never together with the session cookie.",
  });

  for (const operation of operations) {
    registry.registerPath({
      method: operation.method,
      path: `${API_PREFIX}${operation.path}`,
      summary: operation.summary,
      tags: [operation.tag],
      security: !operation.secured
        ? []
        : operation.bearer
          ? [
              { [SESSION_SECURITY_SCHEME]: [] },
              { [BEARER_SECURITY_SCHEME]: [] },
            ]
          : [{ [SESSION_SECURITY_SCHEME]: [] }],
      ...(operation.requestBody ||
      operation.params ||
      operation.query ||
      operation.headers
        ? {
            request: {
              ...(operation.params ? { params: operation.params } : {}),
              ...(operation.query ? { query: operation.query } : {}),
              ...(operation.headers ? { headers: operation.headers } : {}),
              ...(operation.requestBody
                ? {
                    body: {
                      required: true,
                      content: {
                        "application/json": {
                          schema: operation.requestBody,
                          ...(operation.requestExamples
                            ? { examples: operation.requestExamples }
                            : {}),
                        },
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

  // Invoice contracts are also published as explicit components so they stay
  // in the document even when an app is built without the invoice operations.
  const generator = new OpenApiGeneratorV31([
    ...registry.definitions,
    { type: "schema", schema: ErrorResponseSchema },
    { type: "schema", schema: AuthProfileSchema },
    { type: "schema", schema: InvoiceCreateRequestSchema },
    { type: "schema", schema: InvoiceSchema },
    { type: "schema", schema: InvoiceViewSchema },
  ]);

  return generator.generateDocument({
    openapi: "3.1.0",
    tags: TAGS,
    info: {
      title: "InvoiceOps API",
      version: "0.1.0",
      description: "Local recovery P0 API. Only mounted operations are listed.",
    },
  });
}
