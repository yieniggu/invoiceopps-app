import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  isTokenExpired,
  restrictPermissionsByToken,
  validateTokenExpiry,
} from "../../src/features/api-tokens/authorization.js";
import {
  generateTokenSecret,
  hashTokenSecret,
} from "../../src/features/api-tokens/secret.js";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const ALL = {
  readInvoices: true,
  createInvoices: true,
  deleteOwnInvoices: true,
  deleteOthersInvoices: true,
  deployModels: false,
};
const NONE = {
  readInvoices: false,
  createInvoices: false,
  deleteOwnInvoices: false,
  deleteOthersInvoices: false,
  deployModels: false,
};

describe("RP0-16 token secrets (AC-06)", () => {
  it("generates an opaque iop_ secret with at least 256 bits of entropy", () => {
    const { secret } = generateTokenSecret();

    expect(secret.startsWith("iop_")).toBe(true);
    expect(secret.slice(4)).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it("never repeats a secret", () => {
    const secrets = new Set(
      Array.from({ length: 50 }, () => generateTokenSecret().secret),
    );

    expect(secrets.size).toBe(50);
  });

  it("returns the SHA-256 hex of the secret as its hash", () => {
    const { secret, tokenHash } = generateTokenSecret();

    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(sha256(secret));
    expect(hashTokenSecret(secret)).toBe(tokenHash);
    expect(tokenHash).not.toContain(secret);
  });
});

describe("RP0-16 restrictPermissionsByToken (AC-09)", () => {
  it("never grants a permission the owner does not have", () => {
    expect(
      restrictPermissionsByToken(NONE, [
        "invoices:read",
        "invoices:create",
        "invoices:delete-own",
        "invoices:delete-others",
      ]),
    ).toEqual(NONE);
  });

  it("never grants a permission the token does not carry", () => {
    expect(restrictPermissionsByToken(ALL, [])).toEqual(NONE);
    expect(restrictPermissionsByToken(ALL, ["invoices:create"])).toEqual({
      ...NONE,
      createInvoices: true,
    });
  });

  it("is the logical AND of both sides, flag by flag", () => {
    const owner = { ...NONE, readInvoices: true, deleteOwnInvoices: true };

    expect(
      restrictPermissionsByToken(owner, [
        "invoices:read",
        "invoices:create",
        "invoices:delete-others",
      ]),
    ).toEqual({ ...NONE, readInvoices: true });
  });
});

describe("RP0-16 token expiry (AC-06, AC-10)", () => {
  it("treats expiresAt <= now as expired", () => {
    expect(isTokenExpired(new Date(NOW.getTime() - 1), NOW)).toBe(true);
    expect(isTokenExpired(NOW, NOW)).toBe(true);
    expect(isTokenExpired(new Date(NOW.getTime() + 1), NOW)).toBe(false);
  });

  it("accepts an expiry strictly after now and at most 30 days ahead", () => {
    expect(validateTokenExpiry(new Date(NOW.getTime() + 1), NOW)).toBe(true);
    expect(
      validateTokenExpiry(new Date(NOW.getTime() + 30 * DAY_MS), NOW),
    ).toBe(true);
  });

  it("rejects now, the past and anything beyond 30 days", () => {
    expect(validateTokenExpiry(NOW, NOW)).toBe(false);
    expect(validateTokenExpiry(new Date(NOW.getTime() - DAY_MS), NOW)).toBe(
      false,
    );
    expect(
      validateTokenExpiry(new Date(NOW.getTime() + 30 * DAY_MS + 1), NOW),
    ).toBe(false);
  });
});
