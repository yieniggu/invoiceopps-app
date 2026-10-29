import { randomBytes } from "node:crypto";

import { hashPassword } from "../../auth.js";

export const TEMPORARY_PASSWORD_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface TemporaryCredential {
  passwordHash: string;
  /** Present only when the server generated the password. */
  generatedPassword: string | undefined;
}

/**
 * Hashes the administrator-defined temporary password, or generates one when
 * none is given. The hash is slow (scrypt): callers run this outside their
 * transaction and after the authority check.
 */
export async function prepareTemporaryCredential(
  definedPassword: string | undefined,
): Promise<TemporaryCredential> {
  const generatedPassword =
    definedPassword === undefined
      ? randomBytes(24).toString("base64url")
      : undefined;
  const passwordHash = await hashPassword(
    definedPassword ?? generatedPassword!,
  );
  return { passwordHash, generatedPassword };
}

/** Moment at which a temporary password issued now stops being usable. */
export function temporaryPasswordExpiry(now: number = Date.now()): Date {
  return new Date(now + TEMPORARY_PASSWORD_LIFETIME_MS);
}
