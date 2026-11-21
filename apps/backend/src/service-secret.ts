/**
 * Startup validation shared by every service-to-service secret
 * (INTERNAL_INTROSPECTION_SECRET, MODEL_API_SERVICE_TOKEN,
 * GATEWAY_SERVICE_READ_TOKEN). Messages name the variable, never the value.
 */

/** Shortest service credential accepted. */
export const MIN_SERVICE_SECRET_LENGTH = 32;
/** Longest service credential accepted. */
export const MAX_SERVICE_SECRET_LENGTH = 512;

const MIN_HEX_DISTINCT = 8;
const MIN_OTHER_DISTINCT = 10;
const MIN_ENTROPY_BITS_PER_CHAR = 3.5;

function shannonEntropy(value: string) {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/** A short block repeated over and over ("abab...", "1234567890" x 4). */
function isRepeatedBlock(value: string) {
  for (
    let period = 1;
    period <= 16 && period * 2 <= value.length;
    period += 1
  ) {
    let repeats = true;
    for (let index = period; index < value.length; index += 1) {
      if (value[index] !== value[index - period]) {
        repeats = false;
        break;
      }
    }
    if (repeats) return true;
  }
  return false;
}

/**
 * True for something that looks randomly generated: a hex string with a
 * healthy spread of digits (`openssl rand -hex 32`), or any other string with
 * enough distinct characters and Shannon entropy (`openssl rand -base64 48`).
 * It rejects repeated characters, short cycles and common words, not a clever
 * human-made password: the guarantee is "generated, not typed".
 */
export function looksRandom(value: string): boolean {
  if (isRepeatedBlock(value)) return false;
  const distinct = new Set(value).size;
  if (/^[0-9a-f]+$/i.test(value)) return distinct >= MIN_HEX_DISTINCT;
  return (
    distinct >= MIN_OTHER_DISTINCT &&
    shannonEntropy(value) >= MIN_ENTROPY_BITS_PER_CHAR
  );
}

/** Length, whitespace and randomness of one secret; returns it unchanged. */
export function validatedServiceSecret(name: string, value: string): string {
  if (
    value.length < MIN_SERVICE_SECRET_LENGTH ||
    value.length > MAX_SERVICE_SECRET_LENGTH ||
    /\s/.test(value)
  ) {
    throw new Error(
      `${name} must be ${MIN_SERVICE_SECRET_LENGTH}-${MAX_SERVICE_SECRET_LENGTH} characters without whitespace`,
    );
  }
  if (!looksRandom(value)) {
    throw new Error(
      `${name} must be a randomly generated value (for example openssl rand -hex 32)`,
    );
  }
  return value;
}

/**
 * The service credentials must differ from one another: a secret reused
 * across services lets any of them impersonate the others. Unset (blank)
 * values are ignored. The message lists the variable names only.
 */
export function assertDistinctServiceSecrets(
  secrets: Record<string, string | undefined>,
): void {
  const seen = new Map<string, string>();
  for (const [name, value] of Object.entries(secrets)) {
    if (value === undefined || value.trim() === "") continue;
    const previous = seen.get(value);
    if (previous !== undefined) {
      throw new Error(
        `${previous} and ${name} must be different values: every service credential is generated separately`,
      );
    }
    seen.set(value, name);
  }
}
