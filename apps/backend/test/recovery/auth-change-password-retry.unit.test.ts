import request from "../support/request.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

// hashPassword is called inside its own module, so it cannot be spied on
// through its export. Every hash it computes runs one scrypt derivation, so a
// wrapper around node:crypto's scrypt counts the hashes directly (the verifier
// is injected below and never reaches scrypt).
const scryptCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const scrypt = ((...args: Parameters<typeof actual.scrypt>) => {
    scryptCalls.count += 1;
    return actual.scrypt(...args);
  }) as unknown as typeof actual.scrypt;
  return { ...actual, scrypt };
});

import { createApp } from "../../src/app.js";
import { createAuthService, hashSessionToken } from "../../src/auth.js";
import { hashPassword } from "../../src/features/auth/services.js";
import { ApiError } from "../../src/http/errors.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const SESSION = "old-session-token";
const SAME_ORIGIN = { Host: "127.0.0.1", Origin: "http://127.0.0.1" };
const CURRENT = "current-password-1";
const NEXT = "next-password-12345";

let currentHash: string;
beforeAll(async () => {
  currentHash = await hashPassword(CURRENT);
});

// Verifies only the two comparisons changePassword makes, without scrypt.
const verifyPassword = vi.fn(async (password: string) => password === CURRENT);

/**
 * A prisma whose first `failures` transaction attempts lose the serialization
 * race (P2034) before running any statement; later attempts run the callback
 * against recording fakes.
 */
function fixture(failures: number) {
  const created = {
    sessions: [] as Array<{ tokenHash: string }>,
    audits: [] as Array<{ type: string; targetUserId: string }>,
    passwordHashes: [] as string[],
  };
  const transaction = {
    $queryRaw: vi.fn(async () => []),
    user: {
      findUnique: vi.fn(async () => ({
        passwordHash: currentHash,
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
        disabledAt: null,
      })),
      update: vi.fn(async ({ data }: { data: { passwordHash: string } }) => {
        created.passwordHashes.push(data.passwordHash);
      }),
    },
    session: {
      findUnique: vi.fn(async () => ({
        expiresAt: new Date(NOW.getTime() + 60_000),
      })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async ({ data }: { data: { tokenHash: string } }) => {
        created.sessions.push(data);
      }),
    },
    apiToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    platformAdministrativeAuditEvent: {
      create: vi.fn(
        async ({ data }: { data: { type: string; targetUserId: string } }) => {
          created.audits.push(data);
        },
      ),
    },
  };
  let attempts = 0;
  const prisma = {
    session: {
      findUnique: vi.fn(async () => ({
        userId: "user-1",
        expiresAt: new Date(NOW.getTime() + 60_000),
        user: {
          passwordHash: currentHash,
          mustChangePassword: false,
          temporaryPasswordExpiresAt: null,
          disabledAt: null,
        },
      })),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      attempts += 1;
      if (attempts <= failures) {
        throw Object.assign(new Error("write conflict"), { code: "P2034" });
      }
      return callback(transaction);
    }),
  };
  const auth = createAuthService(prisma as unknown as PrismaClient, {
    now: () => NOW,
    verifyPassword,
  });
  return { auth, prisma, created, transaction };
}

describe("changePassword retry (CR-351)", () => {
  it("retries a lost race once without hashing or auditing twice", async () => {
    verifyPassword.mockClear();
    const { auth, prisma, created, transaction } = fixture(1);
    scryptCalls.count = 0;

    const rotated = await auth.changePassword!(SESSION, {
      currentPassword: CURRENT,
      newPassword: NEXT,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    // Both comparisons run once, outside the transaction: the retry only
    // repeats the database work, never the slow password verification.
    expect(verifyPassword).toHaveBeenCalledTimes(2);
    // The new password is hashed exactly once across both attempts.
    expect(scryptCalls.count).toBe(1);
    expect(created.passwordHashes).toHaveLength(1);
    expect(created.passwordHashes[0]).toMatch(/^scrypt\$/);
    expect(created.audits).toEqual([
      expect.objectContaining({
        type: "PASSWORD_CHANGED",
        targetUserId: "user-1",
      }),
    ]);
    expect(
      transaction.platformAdministrativeAuditEvent.create,
    ).toHaveBeenCalledTimes(1);
    // The returned token is the one whose hash was stored as the new session.
    expect(rotated?.sessionToken).toBeTruthy();
    expect(created.sessions).toEqual([
      {
        expiresAt: expect.any(Date),
        tokenHash: hashSessionToken(rotated!.sessionToken),
        userId: "user-1",
      },
    ]);
  });

  it("answers 503 RETRYABLE_CONFLICT when the retries are exhausted", async () => {
    const { auth, prisma, created } = fixture(Number.POSITIVE_INFINITY);

    const failure = await auth.changePassword!(SESSION, {
      currentPassword: CURRENT,
      newPassword: NEXT,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 503,
      code: "RETRYABLE_CONFLICT",
      headers: { "Retry-After": "1" },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(created.audits).toEqual([]);
    expect(created.sessions).toEqual([]);
  });

  it("answers POST /auth/change-password with 503 and Retry-After over HTTP", async () => {
    const { auth, prisma } = fixture(Number.POSITIVE_INFINITY);
    const app = createApp(
      { isReady: async () => true, prisma: prisma as never },
      auth,
    );

    const response = await request(app)
      .post("/api/v1/auth/change-password")
      .set(SAME_ORIGIN)
      .set("Cookie", `invoiceops_session=${SESSION}`)
      .send({ currentPassword: CURRENT, newPassword: NEXT });

    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.body.error.code).toBe("RETRYABLE_CONFLICT");
  });
});
