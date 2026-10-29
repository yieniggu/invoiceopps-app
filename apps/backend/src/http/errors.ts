import type {
  ErrorRequestHandler,
  RequestHandler,
  Response as ExpressResponse,
} from "express";
import { z } from "zod";

import { AuthError } from "../auth.js";
import { logEvent, requestFields } from "./logging.js";

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "INVALID_JSON",
  "AMBIGUOUS_AUTH",
  "PASSWORD_REUSE",
  "PAYLOAD_TOO_LARGE",
  "UNAUTHENTICATED",
  "ONBOARDING_REQUIRED",
  "FORBIDDEN",
  "FORBIDDEN_ORIGIN",
  "NOT_FOUND",
  "USER_NOT_FOUND",
  "CONFLICT",
  "ORGANIZATION_SLUG_CONFLICT",
  "MEMBERSHIP_CONFLICT",
  "LAST_ADMIN_REQUIRED",
  "SELF_ACTION_FORBIDDEN",
  "USER_CONFLICT",
  "ORGANIZATION_MEMBERSHIP_REQUIRED",
  "RATE_LIMITED",
  "BAD_REQUEST",
  "SERVICE_UNAVAILABLE",
  "RETRYABLE_CONFLICT",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string(),
      fields: z.record(z.string(), z.string()).optional(),
    }),
  })
  .meta({
    id: "Error",
    description: "Uniform error envelope returned for every failed request.",
    examples: [
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request",
          fields: {
            currentPassword: "Invalid input: expected string",
          },
        },
      },
    ],
  });

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
    /** Extra response headers, for example Retry-After. */
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

// The single place where AuthError statuses become public error codes.
const AUTH_ERROR_CODES: Record<AuthError["status"], ErrorCode> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
};

export function sendError(
  response: ExpressResponse,
  status: number,
  code: ErrorCode,
  message: string,
  fields?: Record<string, string>,
) {
  const body: ErrorResponse = {
    error: { code, message, ...(fields ? { fields } : {}) },
  };
  response.status(status).json(body);
}

// Field names come from client input, so the map has no prototype: a key such
// as "__proto__" is stored as an ordinary own property instead of being lost.
function fieldsFromZod(error: z.ZodError) {
  const fields: Record<string, string> = Object.create(null);
  const add = (name: string, message: string) => {
    if (!Object.hasOwn(fields, name)) fields[name] = message;
  };
  for (const issue of error.issues) {
    const path = issue.path.map(String);
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys)
        add([...path, key].join("."), "Unknown field");
    } else {
      add(path.join(".") || "body", issue.message);
    }
  }
  return fields;
}

/** Parses with a Zod schema; invalid input becomes a 400 VALIDATION_ERROR. */
export function parseWith<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  message = "Invalid request",
  { exposeFields = true }: { exposeFields?: boolean } = {},
): z.infer<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      message,
      exposeFields ? fieldsFromZod(result.error) : undefined,
    );
  }
  return result.data;
}

/**
 * Same as parseWith for the legacy routes: their error bodies never carried
 * `fields`, and the documented routes (RP0-05+) will adopt them on migration.
 */
export function parseLegacy<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  message: string,
): z.infer<Schema> {
  return parseWith(schema, input, message, { exposeFields: false });
}

export const notFoundHandler: RequestHandler = (_request, response) => {
  sendError(response, 404, "NOT_FOUND", "Route not found");
};

export const errorHandler: ErrorRequestHandler = (
  error,
  request,
  response,
  _next,
) => {
  if (error instanceof ApiError) {
    if (error.headers) response.set(error.headers);
    sendError(response, error.status, error.code, error.message, error.fields);
    return;
  }

  if (error instanceof AuthError) {
    sendError(
      response,
      error.status,
      error.code ?? AUTH_ERROR_CODES[error.status],
      error.message,
    );
    return;
  }

  const bodyError = error as { type?: unknown } | null;
  if (bodyError?.type === "entity.parse.failed") {
    sendError(response, 400, "INVALID_JSON", "Invalid JSON body");
    return;
  }
  if (bodyError?.type === "entity.too.large") {
    sendError(response, 413, "PAYLOAD_TOO_LARGE", "Request body too large");
    return;
  }

  // Any other client error raised by Express or middleware (for example a
  // malformed URL escape) keeps its 4xx status with a generic message.
  const clientError = error as { status?: unknown; statusCode?: unknown };
  const clientStatus = [clientError?.status, clientError?.statusCode].find(
    (value): value is number =>
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 400 &&
      value <= 499,
  );
  if (clientStatus !== undefined) {
    sendError(response, clientStatus, "BAD_REQUEST", "Bad request");
    return;
  }

  // Never log the error object or its message: driver and Prisma errors can
  // embed query values. Only the class name and the Prisma code are recorded.
  const failure = error as { name?: unknown; code?: unknown } | null;
  logEvent("error", "http.unhandled_error", {
    ...requestFields(request, response),
    code: "INTERNAL_ERROR",
    errorName: typeof failure?.name === "string" ? failure.name : "unknown",
    ...(typeof failure?.code === "string" && /^P\d{4}$/.test(failure.code)
      ? { prismaCode: failure.code }
      : {}),
  });
  sendError(response, 500, "INTERNAL_ERROR", "Internal server error");
};
