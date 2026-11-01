import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Express } from "express";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import request from "../support/request.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Public scope names, in the order the API documents them. */
export const API_SCOPES = [
  "invoices:read",
  "invoices:create",
  "invoices:delete-own",
  "invoices:delete-others",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

const ENUM_BY_SCOPE = {
  "invoices:read": "INVOICES_READ",
  "invoices:create": "INVOICES_CREATE",
  "invoices:delete-own": "INVOICES_DELETE_OWN",
  "invoices:delete-others": "INVOICES_DELETE_OTHERS",
} as const satisfies Record<ApiScope, string>;

export const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** A known opaque secret with the documented `iop_` prefix. */
export const newSecret = () => `iop_${randomBytes(32).toString("base64url")}`;

export interface SeedTokenOptions {
  userId: string;
  organizationId: string;
  groupId?: string | null;
  scopes?: readonly ApiScope[];
  expiresAt?: Date;
  createdAt?: Date;
  revokedAt?: Date | null;
}

/**
 * Inserts an ApiToken row directly (known secret, SHA-256 hash only), so the
 * Bearer tests never depend on the emission endpoint.
 */
export async function seedApiToken(
  prisma: PrismaClient,
  options: SeedTokenOptions,
) {
  const secret = newSecret();
  const expiresAt = options.expiresAt ?? new Date(Date.now() + DAY_MS);
  const row = await prisma.apiToken.create({
    data: {
      userId: options.userId,
      name: `token-${randomUUID()}`,
      organizationId: options.organizationId,
      groupId: options.groupId ?? null,
      tokenHash: sha256Hex(secret),
      scopes: (options.scopes ?? API_SCOPES).map(
        (scope) => ENUM_BY_SCOPE[scope],
      ),
      // CHECK ("expiresAt" > "createdAt"): an already-expired token needs an
      // earlier createdAt.
      createdAt: options.createdAt ?? new Date(expiresAt.getTime() - DAY_MS),
      expiresAt,
      revokedAt: options.revokedAt ?? null,
    },
  });
  return { id: row.id, secret };
}

/** A request carrying only a Bearer credential: no cookie, no Origin. */
export function bearerCall(
  app: Express,
  method: "get" | "post" | "patch" | "put" | "delete",
  path: string,
  secret: string,
  body?: unknown,
) {
  const agent = request(app);
  const test = agent[method](`/api/v1${path}`)
    .set("Host", "127.0.0.1")
    .set("Authorization", `Bearer ${secret}`);
  return body === undefined ? test : test.send(body as object);
}
