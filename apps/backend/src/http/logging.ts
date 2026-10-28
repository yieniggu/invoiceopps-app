// Structured single-line JSON logs on the console (no logging dependency).
// Events carry only a fixed vocabulary of non-sensitive fields: never request
// or response bodies, error messages, RUTs, cookies, tokens or passwords.
import type { Request, Response } from "express";

export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  code?: string;
  method?: string;
  route?: string;
  errorName?: string;
  prismaCode?: string;
  reason?: string;
  scope?: string;
  /** Audit events: opaque identifiers only, never RUTs, names or secrets. */
  feature?: string;
  action?: string;
  organizationId?: string;
  groupId?: string;
  actorUserId?: string;
  targetUserId?: string;
  /** Bulk audit events: how many memberships the batch touched. */
  memberCount?: number;
}

export function logEvent(
  level: LogLevel,
  event: string,
  fields: LogFields = {},
) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

/**
 * Matched route pattern ("/api/v1/auth/login"), never the raw URL or query.
 * Express resets `baseUrl` once the router unwinds, so the API router records
 * its mount path in `response.locals.routeBase` for the error handler.
 */
export function routePattern(request: Request, response?: Response): string {
  const path = request.route?.path;
  if (typeof path !== "string") return "unmatched";
  const base = request.baseUrl || response?.locals.routeBase || "";
  return `${base}${path}`;
}

export function requestFields(
  request: Request,
  response?: Response,
): LogFields {
  return {
    method: request.method,
    route: routePattern(request, response),
  };
}
