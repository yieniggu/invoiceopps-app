import { createHash, randomBytes } from "node:crypto";

/** Prefix that makes an operational token recognizable in logs and scanners. */
export const TOKEN_SECRET_PREFIX = "iop_";

/** 32 random bytes: 256 bits of entropy, 43 base64url characters. */
const SECRET_BYTES = 32;

/** SHA-256 hex of a token secret: the only form that is ever stored. */
export function hashTokenSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * A new opaque secret and its hash. The secret is shown to the owner once;
 * the database keeps only the hash. The entropy is high enough that a fast
 * unsalted hash is appropriate (unlike a password).
 */
export function generateTokenSecret() {
  const secret = `${TOKEN_SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { secret, tokenHash: hashTokenSecret(secret) };
}
