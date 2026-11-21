import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import { pageWindow } from "../../pagination.js";
import { runSerializable, SERIALIZABLE } from "../../transactions.js";
import { hashSessionToken, lockUser } from "../auth/services.js";
import { loadEffectivePermissions } from "../groups/invoice-permissions.js";
import { lockMembershipsForInvoiceWrite } from "../groups/locks.js";
import { validateTokenExpiry } from "./authorization.js";
import { generateTokenSecret } from "./secret.js";
import { hasMlflowAccess } from "./mlflow-access.js";
import {
  FLAG_BY_SCOPE,
  fromStoredScopes,
  isInvoiceScope,
  isMlflowScope,
  toStoredScopes,
} from "./scopes.js";
import type {
  ApiTokenCreatedResponse,
  ApiTokenCreateRequest,
  ApiTokenListQuery,
  ApiTokenMetadata,
  ApiTokenPage,
} from "./types.js";

/** Live (not revoked, not expired) tokens one user may hold per organization. */
export const MAX_ACTIVE_TOKENS_PER_ORGANIZATION = 50;

/** Emission attempts one user may make per 15-minute window. */
export const TOKEN_ISSUANCE_MAX_PER_WINDOW = 20;

export interface ApiTokenService {
  /**
   * Emits a token for the session user. `sessionToken` is re-validated inside
   * the transaction, so a password change or session revocation that commits
   * first refuses the emission (401) and one that commits after revokes it.
   */
  createToken(
    actor: { userId: string; sessionToken: string },
    request: ApiTokenCreateRequest,
  ): Promise<ApiTokenCreatedResponse>;
  listTokens(userId: string, query: ApiTokenListQuery): Promise<ApiTokenPage>;
  /**
   * Revokes an own token. `revoked` is true only when this call revoked it;
   * a repeat resolves with `revoked: false`. Anyone else's token, a missing
   * one and a malformed id all answer the same 404.
   */
  revokeToken(
    userId: string,
    tokenId: string,
  ): Promise<{ revoked: boolean; organizationId: string }>;
}

function notFound() {
  return new ApiError(404, "NOT_FOUND", "Not found");
}

/** Explicit DTO: a database row is never spread into a response. */
function toTokenDto(row: {
  id: string;
  name: string;
  organizationId: string;
  groupId: string | null;
  scopes: Parameters<typeof fromStoredScopes>[0];
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}): ApiTokenMetadata {
  return {
    id: row.id,
    name: row.name,
    organizationId: row.organizationId,
    groupId: row.groupId,
    scopes: fromStoredScopes(row.scopes),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export function createApiTokenService(prisma: PrismaClient): ApiTokenService {
  /**
   * One serializable attempt. Lock order (features/groups/locks.ts): the User
   * row, then the organization membership and the group membership, all of
   * them held until commit. The user lock is the one password change and
   * session revocation take, so they serialize with the emission; the session
   * is re-read under it.
   */
  async function attempt(
    transaction: Prisma.TransactionClient,
    actor: { userId: string; sessionToken: string },
    request: ApiTokenCreateRequest,
    secret: ReturnType<typeof generateTokenSecret>,
  ) {
    const { userId } = actor;
    const { organizationId } = request;
    const groupId = request.groupId ?? null;
    await lockUser(transaction, userId);
    const at = new Date();
    const session = await transaction.session.findUnique({
      where: { tokenHash: hashSessionToken(actor.sessionToken) },
      select: {
        userId: true,
        expiresAt: true,
        user: { select: { disabledAt: true } },
      },
    });
    if (
      !session ||
      session.userId !== userId ||
      session.expiresAt <= at ||
      session.user.disabledAt
    ) {
      throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
    }

    const { organizationMembership } = await lockMembershipsForInvoiceWrite(
      transaction,
      { userId, organizationId, groupId },
    );
    // Nonexistent organization, non-member and platform administrator without
    // a membership are indistinguishable.
    if (!organizationMembership) throw notFound();
    if (groupId !== null) {
      const group = await transaction.group.findFirst({
        where: { id: groupId, organizationId },
        select: { id: true },
      });
      if (!group) throw notFound();
    }
    // Current effective permissions in the token's scope: organization flags
    // for an organization token, organization OR group flags for a group one.
    const permissions = await loadEffectivePermissions(transaction, {
      userId,
      organizationId,
      groupId,
    });
    const expiresAt = new Date(request.expiresAt);
    // Invoice scopes need the matching permission flag; MLflow scopes need an
    // active membership of the context (see hasMlflowAccess).
    const exceedsInvoicePermissions = request.scopes
      .filter(isInvoiceScope)
      .some((scope) => !permissions[FLAG_BY_SCOPE[scope]]);
    const exceedsMlflowAccess =
      request.scopes.some(isMlflowScope) &&
      !(await hasMlflowAccess(transaction, {
        userId,
        organizationId,
        groupId,
      }));
    if (exceedsInvoicePermissions || exceedsMlflowAccess) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "The requested scopes exceed your current permissions",
      );
    }
    // The body was validated earlier; the database CHECKs are anchored on
    // createdAt, which is this instant.
    if (!validateTokenExpiry(expiresAt, at)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Invalid API token", {
        expiresAt: "expiresAt must be in the future and at most 30 days ahead",
      });
    }
    // Under the user lock, so concurrent emissions of one user serialize and
    // can never exceed the cap together. Revoked and expired tokens are free.
    const active = await transaction.apiToken.count({
      where: {
        userId,
        organizationId,
        revokedAt: null,
        expiresAt: { gt: at },
      },
    });
    if (active >= MAX_ACTIVE_TOKENS_PER_ORGANIZATION) {
      throw new ApiError(
        409,
        "TOKEN_LIMIT",
        `At most ${MAX_ACTIVE_TOKENS_PER_ORGANIZATION} active API tokens are allowed per organization; revoke one first`,
      );
    }
    return transaction.apiToken.create({
      data: {
        userId,
        name: request.name,
        organizationId,
        groupId,
        tokenHash: secret.tokenHash,
        scopes: toStoredScopes(request.scopes),
        createdAt: at,
        expiresAt,
      },
    });
  }

  return {
    async createToken(actor, request) {
      const secret = generateTokenSecret();
      const row = await runSerializable(
        () =>
          prisma.$transaction(
            (transaction) => attempt(transaction, actor, request, secret),
            SERIALIZABLE,
          ),
        undefined,
        "api_token_create",
      );
      return { token: toTokenDto(row), secret: secret.secret };
    },

    async listTokens(userId, query) {
      const where = {
        userId,
        organizationId: query.organizationId,
        ...(query.groupId !== undefined ? { groupId: query.groupId } : {}),
      };
      const rows = await prisma.apiToken.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        ...pageWindow(query),
      });
      const total = await prisma.apiToken.count({ where });
      return {
        items: rows.map(toTokenDto),
        page: query.page,
        pageSize: query.pageSize,
        total,
      };
    },

    async revokeToken(userId, tokenId) {
      // Conditional on ownership and on not being revoked yet: a repeat keeps
      // the first revokedAt, and a concurrent Bearer write holding the row
      // FOR SHARE finishes before the revocation applies.
      const { count } = await prisma.apiToken.updateMany({
        where: { id: tokenId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const own = await prisma.apiToken.findFirst({
        where: { id: tokenId, userId },
        select: { organizationId: true },
      });
      if (!own) throw notFound();
      return { revoked: count === 1, organizationId: own.organizationId };
    },
  };
}
