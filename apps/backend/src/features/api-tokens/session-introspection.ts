import type { RequestHandler } from "express";
import { z } from "zod";

import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { ApiError, parseWith } from "../../http/errors.js";
import {
  ACTIVE_CACHE_TTL_SECONDS,
  INACTIVE_CACHE_TTL_SECONDS,
} from "./introspection.js";
import { hashTokenSecret } from "./secret.js";

/** Path of the private session introspection endpoint; never part of the public API. */
export const SESSION_INTROSPECTION_PATH = "/internal/sessions/introspect";

export const SessionIntrospectRequestSchema = z.object({
  sessionToken: z.string().min(1).max(512),
});

export interface SessionMlflowContext {
  organizationId: string;
  groupId: string | null;
  /** Human readable name for the gateway's context picker. */
  label: string;
}

export type SessionIntrospectResult =
  | {
      active: true;
      userId: string;
      contexts: SessionMlflowContext[];
      cacheTtlSeconds: number;
    }
  | { active: false; cacheTtlSeconds: number };

const INACTIVE: SessionIntrospectResult = {
  active: false,
  cacheTtlSeconds: INACTIVE_CACHE_TTL_SECONDS,
};

export interface SessionIntrospectionService {
  /**
   * Resolves the raw value of the MLflow-only child session token (the
   * gateway's cookie; an app session token never resolves here). Active only
   * while the child is unexpired, its parent app session is alive, and the
   * user is enabled, past onboarding, with at least one context where MLflow
   * may be used (the same rule as token issuance, see `hasMlflowAccess`; an
   * organization with the Models section off, mlEnabled, offers none): the
   * organization itself and every group of it the user belongs to. Every other
   * case is the same `{ active: false }`.
   */
  introspect(sessionToken: string): Promise<SessionIntrospectResult>;
}

/** What the MLflow contexts of a user are computed from. */
export const MLFLOW_USER_SELECT = {
  id: true,
  disabledAt: true,
  mustChangePassword: true,
  memberships: {
    where: { organization: { enabled: true, mlEnabled: true } },
    orderBy: [{ organizationId: "asc" }],
    select: {
      organization: { select: { id: true, name: true } },
      groupMemberships: {
        orderBy: [{ groupId: "asc" }],
        select: { group: { select: { id: true, name: true } } },
      },
    },
  },
} as const satisfies Prisma.UserSelect;

export type MlflowUserState = Prisma.UserGetPayload<{
  select: typeof MLFLOW_USER_SELECT;
}>;

/** The contexts of an eligible user; empty for a disabled or onboarding user. */
export function mlflowContextsOf(user: MlflowUserState) {
  const contexts: SessionMlflowContext[] = [];
  if (user.disabledAt || user.mustChangePassword) return contexts;
  for (const membership of user.memberships) {
    const { organization } = membership;
    contexts.push({
      organizationId: organization.id,
      groupId: null,
      label: organization.name,
    });
    for (const { group } of membership.groupMemberships) {
      contexts.push({
        organizationId: organization.id,
        groupId: group.id,
        label: `${organization.name} / ${group.name}`,
      });
    }
  }
  return contexts;
}

export function createSessionIntrospectionService(
  prisma: PrismaClient,
  now: () => Date = () => new Date(),
): SessionIntrospectionService {
  return {
    async introspect(sessionToken) {
      const child = await prisma.mlflowSession.findUnique({
        where: { tokenHash: hashTokenSecret(sessionToken) },
        select: {
          expiresAt: true,
          session: { select: { expiresAt: true } },
          user: { select: MLFLOW_USER_SELECT },
        },
      });
      const at = now();
      if (!child || child.expiresAt <= at || child.session.expiresAt <= at) {
        return INACTIVE;
      }
      const contexts = mlflowContextsOf(child.user);
      if (contexts.length === 0) return INACTIVE;
      return {
        active: true,
        userId: child.user.id,
        contexts,
        cacheTtlSeconds: ACTIVE_CACHE_TTL_SECONDS,
      };
    },
  };
}

export function createSessionIntrospectionHandler(
  service: SessionIntrospectionService | undefined,
): RequestHandler {
  return async (request, response) => {
    if (!service) throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
    const { sessionToken } = parseWith(
      SessionIntrospectRequestSchema,
      request.body,
      "Invalid introspection request",
    );
    const result = await service.introspect(sessionToken);
    response.setHeader(
      "Cache-Control",
      `private, max-age=${result.cacheTtlSeconds}`,
    );
    response.status(200).json(result);
  };
}
