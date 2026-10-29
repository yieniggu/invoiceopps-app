import { createHash } from "node:crypto";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { describe, expect, it, vi } from "vitest";

import { createAuthService } from "../../src/auth.js";

const NOW = new Date("2026-10-28T12:00:00.000Z");

// Same digest the service stores for a session token (sha256, base64).
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("base64");
const userByTokenHash = new Map([
  [hashToken("a"), "user-a"],
  [hashToken("b"), "user-b"],
]);

function fixture() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const updateMany = vi.fn(async () => {
    await gate;
    return { count: 1 };
  });
  const sessionFor = (userId: string) => ({
    expiresAt: new Date(NOW.getTime() + 60_000),
    user: {
      id: userId,
      name: "Ada",
      rut: "111111111",
      email: "ada@example.test",
      username: "ada",
      mustChangePassword: false,
      disabledAt: null,
      lastActiveAt: null,
      platformAdministrator: null,
      memberships: [],
    },
  });
  const prisma = {
    session: {
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
        const userId = userByTokenHash.get(where.tokenHash);
        if (!userId) throw new Error("unexpected token hash");
        return sessionFor(userId);
      }),
    },
    user: { updateMany },
  } as unknown as PrismaClient;
  const auth = createAuthService(prisma, { now: () => NOW });
  return { auth, updateMany, release };
}

describe("activity write de-duplication (CR-295)", () => {
  it("issues one pending write per user however many profile reads overlap", async () => {
    const { auth, updateMany, release } = fixture();
    await Promise.all(Array.from({ length: 12 }, () => auth.getProfile("a")));
    // The write is still blocked: further reads do not queue another one.
    await auth.getProfile("a");
    expect(updateMany).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(updateMany).toHaveBeenCalledTimes(1));
  });

  it("allows another write once the pending one settled, and keeps users apart", async () => {
    const { auth, updateMany, release } = fixture();
    expect((await auth.getProfile("a")).id).toBe("user-a");
    expect((await auth.getProfile("b")).id).toBe("user-b");
    // Two different users: one write each.
    expect(updateMany).toHaveBeenCalledTimes(2);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await auth.getProfile("a");
    expect(updateMany).toHaveBeenCalledTimes(3);
  });

  it("forgets a failed write so the next read can try again", async () => {
    const { auth, updateMany } = fixture();
    updateMany.mockRejectedValueOnce(new Error("lock timeout"));
    await auth.getProfile("a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await auth.getProfile("a");
    expect(updateMany).toHaveBeenCalledTimes(2);
  });
});
