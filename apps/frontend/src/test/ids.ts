/** Deterministic UUID fixtures: the server refuses ids that are not UUIDs. */
export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const VARIANT = { org: "9000", group: "a000", user: "b000" } as const;

/** FNV-1a, 32 bits, with a seed so two passes give independent halves. */
const fnv1a = (text: string, seed: number) => {
  let hash = seed >>> 0;
  for (const char of text) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
};

/**
 * Deterministic UUID for a fixture that is easier to read by key (`"A"`, 7):
 * the kind picks the UUID group. A plain number (no leading zeros, up to 12
 * digits) is the tail itself, like `uuid(n)`; any other key is hashed together
 * with its kind into a tail that starts with `f`, so it can never equal a
 * numeric tail (those are digits only) nor the tail of another key.
 */
export const namedId = (kind: keyof typeof VARIANT, key: string | number) => {
  const text = String(key);
  const tail = /^(0|[1-9]\d{0,11})$/.test(text)
    ? text.padStart(12, "0")
    : `f${fnv1a(`${kind}:${text}`, 0x811c9dc5).toString(16).padStart(8, "0")}${(
        fnv1a(`${kind}:${text}`, 0x9747b28c) & 0xfff
      )
        .toString(16)
        .padStart(3, "0")}`;
  return `00000000-0000-4000-${VARIANT[kind]}-${tail}`;
};
