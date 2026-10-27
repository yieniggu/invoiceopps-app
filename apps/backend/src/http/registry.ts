import type { RequestHandler, Router } from "express";
import type { ZodObject, ZodType } from "zod";

import { ErrorResponseSchema } from "./errors.js";

export const API_PREFIX = "/api/v1";

export interface OperationResponse {
  description: string;
  /** Omit for bodiless responses such as 204. */
  schema?: ZodType;
  /** Response headers set by the handler, name to description. */
  headers?: Record<string, { description: string }>;
}

/**
 * One documented operation. The same object mounts the Express route and feeds
 * the OpenAPI generator, so HTTP behaviour and documentation cannot drift.
 */
/**
 * Statuses any operation can return regardless of its handler: the 16 kB JSON
 * body limit (413), an unsupported body charset or encoding (415)
 * and an unexpected failure (500). The generator merges them
 * under every operation's own responses, which win on a conflict.
 */
export const COMMON_ERROR_RESPONSES: Record<number, OperationResponse> = {
  413: {
    description: "PAYLOAD_TOO_LARGE: the JSON body exceeds 16 kB",
    schema: ErrorResponseSchema,
  },
  415: {
    description:
      "BAD_REQUEST: unsupported charset or Content-Encoding for the JSON body",
    schema: ErrorResponseSchema,
  },
  500: {
    description: "INTERNAL_ERROR: unexpected failure; no detail is exposed",
    schema: ErrorResponseSchema,
  },
};

export interface Operation {
  method: "get" | "post" | "patch" | "delete";
  /** OpenAPI-style path relative to API_PREFIX, for example "/auth/login". */
  path: string;
  summary: string;
  tag: string;
  /** Requires the web session cookie. */
  secured: boolean;
  /** Path parameters; names must match the `{name}` segments of `path`. */
  params?: ZodObject;
  requestBody?: ZodType;
  responses: Record<number, OperationResponse>;
  middleware?: RequestHandler[];
  handler: RequestHandler;
}

export function mountOperations(router: Router, operations: Operation[]) {
  for (const operation of operations) {
    const expressPath = operation.path.replace(/\{(\w+)\}/g, ":$1");
    router[operation.method](
      expressPath,
      ...(operation.middleware ?? []),
      operation.handler,
    );
  }
}

/** Owner marker for legacy routes that no P0 ticket will reshape. */
export const LEGACY_NO_P0 = "LEGACY-NO-P0";

export interface LegacyRoute {
  method: string;
  path: string;
  /** Ticket that will reshape the route and document it. */
  owner: string;
}

/**
 * Mounted routes that are intentionally not documented yet. Route parity fails
 * when a mounted route is in neither the OpenAPI document nor this list, so a
 * route can only leave it by being documented by its owning ticket.
 */
export const LEGACY_ROUTES: ReadonlyArray<LegacyRoute> = [
  // Business-policy authority is preserved but no P0 ticket owns these
  // routes: they keep working undocumented until someone decides to retire or
  // keep them (backlog "inherited follow-ups" table, CR-019).
  { method: "GET", path: "/api/v1/business-policies", owner: LEGACY_NO_P0 },
  { method: "POST", path: "/api/v1/business-policies", owner: LEGACY_NO_P0 },
  {
    method: "PATCH",
    path: "/api/v1/business-policies/{version}",
    owner: LEGACY_NO_P0,
  },
  // Kept for the policies screen; no P0 ticket reshapes it.
  { method: "GET", path: "/api/v1/groups", owner: LEGACY_NO_P0 },
  { method: "GET", path: "/api/v1/invoices", owner: "RP0-11" },
  { method: "GET", path: "/api/v1/invoices/{invoiceId}", owner: "RP0-11" },
];
