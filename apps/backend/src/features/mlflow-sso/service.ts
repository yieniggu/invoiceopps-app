import { randomBytes } from "node:crypto";

import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import {
  mapTransactionTimeout,
  TRANSACTION_TIMING,
} from "../../transactions.js";
import { hashSessionToken } from "../auth/services.js";
import { hashTokenSecret } from "../api-tokens/secret.js";
import {
  MLFLOW_USER_SELECT,
  mlflowContextsOf,
} from "../api-tokens/session-introspection.js";

/** A handoff code lives this long and works once. */
export const HANDOFF_CODE_TTL_MS = 60_000;
/** Longest life of a child session, further capped by its parent's expiry. */
export const MLFLOW_SESSION_MAX_MS = 8 * 60 * 60 * 1000;
/** Prefix that makes a child token recognizable (and distinct from app sessions). */
export const MLFLOW_SESSION_PREFIX = "mls_";

const RANDOM_BYTES = 32; // 256 bits

export type AuthorizeResult =
  | { status: "issued"; code: string }
  | { status: "unauthenticated" }
  | { status: "no_access" };

export interface ExchangeResult {
  sessionToken: string;
  expiresInSeconds: number;
}

export interface MlflowSsoService {
  /** Issues a single-use code bound to the app session behind `sessionToken`. */
  authorize(sessionToken: string): Promise<AuthorizeResult>;
  /** Atomically consumes a code into a child session; null for any failure. */
  exchange(code: string): Promise<ExchangeResult | null>;
  /** Revokes one child session; idempotent. */
  revoke(childToken: string): Promise<void>;
}

export function createMlflowSsoService(
  prisma: PrismaClient,
  now: () => Date = () => new Date(),
): MlflowSsoService {
  return {
    async authorize(sessionToken) {
      const at = now();
      const session = await prisma.session.findUnique({
        where: { tokenHash: hashSessionToken(sessionToken) },
        select: {
          id: true,
          userId: true,
          expiresAt: true,
          user: { select: MLFLOW_USER_SELECT },
        },
      });
      if (
        !session ||
        session.expiresAt <= at ||
        session.user.disabledAt ||
        session.user.mustChangePassword
      ) {
        return { status: "unauthenticated" };
      }
      if (mlflowContextsOf(session.user).length === 0) {
        return { status: "no_access" };
      }
      const code = randomBytes(RANDOM_BYTES).toString("base64url");
      // Opportunistic cleanup keeps the tables small without a scheduler.
      await prisma.mlflowHandoffCode.deleteMany({
        where: { expiresAt: { lt: new Date(at.getTime() - 60 * 60 * 1000) } },
      });
      await prisma.mlflowSession.deleteMany({
        where: { expiresAt: { lt: at } },
      });
      await prisma.mlflowHandoffCode.create({
        data: {
          codeHash: hashTokenSecret(code),
          userId: session.userId,
          sessionId: session.id,
          expiresAt: new Date(at.getTime() + HANDOFF_CODE_TTL_MS),
        },
      });
      return { status: "issued", code };
    },

    async exchange(code) {
      const at = now();
      const codeHash = hashTokenSecret(code);
      try {
        return await mapTransactionTimeout(
          () =>
            prisma.$transaction(async (transaction) => {
              // Lock order: Session row first, code row second. Logout, password
              // change and deactivation delete the Session row (taking it FOR
              // UPDATE) and then cascade to its codes, so claiming the code first
              // and only then touching the Session (the FK check of the
              // MlflowSession insert) is the opposite order and can deadlock.
              // FOR KEY SHARE is the lock that FK check takes anyway; it conflicts
              // with the delete, never with other exchanges.
              const peek = await transaction.mlflowHandoffCode.findUnique({
                where: { codeHash },
                select: { sessionId: true },
              });
              if (!peek) return null;
              const locked = await transaction.$queryRaw<
                { id: string }[]
              >`SELECT id FROM "Session" WHERE id = ${peek.sessionId} FOR KEY SHARE`;
              if (locked.length === 0) return null;
              // Atomic claim: of any number of concurrent exchanges exactly one
              // flips consumedAt; a replay or an expired code matches no row.
              const claimed = await transaction.mlflowHandoffCode.updateMany({
                where: { codeHash, consumedAt: null, expiresAt: { gt: at } },
                data: { consumedAt: at },
              });
              if (claimed.count !== 1) return null;
              const row = await transaction.mlflowHandoffCode.findUnique({
                where: { codeHash },
                select: {
                  userId: true,
                  sessionId: true,
                  session: {
                    select: {
                      expiresAt: true,
                      user: { select: MLFLOW_USER_SELECT },
                    },
                  },
                },
              });
              if (
                !row ||
                row.session.expiresAt <= at ||
                mlflowContextsOf(row.session.user).length === 0
              ) {
                return null;
              }
              const expiresAt = new Date(
                Math.min(
                  row.session.expiresAt.getTime(),
                  at.getTime() + MLFLOW_SESSION_MAX_MS,
                ),
              );
              const sessionToken = `${MLFLOW_SESSION_PREFIX}${randomBytes(RANDOM_BYTES).toString("base64url")}`;
              await transaction.mlflowSession.create({
                data: {
                  tokenHash: hashTokenSecret(sessionToken),
                  userId: row.userId,
                  sessionId: row.sessionId,
                  expiresAt,
                },
              });
              return {
                sessionToken,
                expiresInSeconds: Math.max(
                  1,
                  Math.floor((expiresAt.getTime() - at.getTime()) / 1000),
                ),
              };
            }, TRANSACTION_TIMING),
          "mlflow_exchange",
        );
      } catch (error) {
        // The parent session ended between the claim and the insert.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2003"
        ) {
          return null;
        }
        throw error;
      }
    },

    async revoke(childToken) {
      await prisma.mlflowSession.deleteMany({
        where: { tokenHash: hashTokenSecret(childToken) },
      });
    },
  };
}
