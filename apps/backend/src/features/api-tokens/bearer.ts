import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import { isTokenExpired } from "./authorization.js";
import { hashTokenSecret } from "./secret.js";
import { fromStoredScopes } from "./scopes.js";
import type { ApiTokenContext } from "./types.js";

/** One 401 for every bad credential: unknown, expired, revoked or disabled. */
export function bearerUnauthenticated() {
  return new ApiError(401, "UNAUTHENTICATED", "Unauthenticated", undefined, {
    "WWW-Authenticate": "Bearer",
  });
}

function onboardingRequired() {
  return new ApiError(403, "ONBOARDING_REQUIRED", "Password change required");
}

/** The owner must be enabled and past onboarding for any token to work. */
function requireUsableOwner(
  owner: { disabledAt: Date | null; mustChangePassword: boolean } | null,
) {
  if (!owner || owner.disabledAt) throw bearerUnauthenticated();
  if (owner.mustChangePassword) throw onboardingRequired();
}

export interface ApiTokenAuthenticator {
  /** Resolves a presented secret to its owner and token, or throws 401/403. */
  authenticate(
    secret: string,
  ): Promise<{ userId: string; token: ApiTokenContext }>;
}

export function createApiTokenAuthenticator(
  prisma: PrismaClient,
  now: () => Date = () => new Date(),
): ApiTokenAuthenticator {
  return {
    async authenticate(secret) {
      const row = await prisma.apiToken.findUnique({
        where: { tokenHash: hashTokenSecret(secret) },
        select: {
          id: true,
          userId: true,
          organizationId: true,
          groupId: true,
          scopes: true,
          expiresAt: true,
          revokedAt: true,
          user: { select: { disabledAt: true, mustChangePassword: true } },
        },
      });
      if (!row || row.revokedAt || isTokenExpired(row.expiresAt, now())) {
        throw bearerUnauthenticated();
      }
      requireUsableOwner(row.user);
      return {
        userId: row.userId,
        token: {
          id: row.id,
          organizationId: row.organizationId,
          groupId: row.groupId,
          scopes: fromStoredScopes(row.scopes),
        },
      };
    },
  };
}

/**
 * Re-checks a Bearer credential inside the transaction of the operation, so
 * a revocation that committed first is always seen. With `lock` the token row
 * is held FOR SHARE until the transaction ends: a concurrent revocation (an
 * UPDATE of the row) waits for the write, and a write that started after the
 * revocation committed finds the token revoked. Lock order: the User row (not
 * taken by this path; revocations lock it first) -> ApiToken -> memberships.
 * Reads only check; they hold no lock: a read whose transaction started before
 * a revocation committed may still return data, while any request that starts
 * after the commit is rejected.
 */
export async function requireLiveApiToken(
  transaction: Prisma.TransactionClient,
  userId: string,
  token: ApiTokenContext,
  { lock }: { lock: boolean },
) {
  if (lock) {
    const rows = await transaction.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM "ApiToken" WHERE id = ${token.id} AND "userId" = ${userId} AND "revokedAt" IS NULL AND "expiresAt" > now() FOR SHARE`;
    if (rows.length === 0) throw bearerUnauthenticated();
  } else {
    const live = await transaction.apiToken.findFirst({
      where: {
        id: token.id,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!live) throw bearerUnauthenticated();
  }
  requireUsableOwner(
    await transaction.user.findUnique({
      where: { id: userId },
      select: { disabledAt: true, mustChangePassword: true },
    }),
  );
}
