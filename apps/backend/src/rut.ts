// Chilean RUT module. Storage form is canonical ("190347907": digits + DV, no
// separators, uppercase K). API form is "19034790-7" (body, dash, DV).
// The body never starts with 0, so every RUT has a single canonical form.
const RUT_PATTERN = /^([1-9]\d{6,7}|[1-9]\d?(?:\.\d{3}){2})-?([0-9Kk])$/;

export class RutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RutError";
  }
}

function verificationDigitFor(body: string): string {
  let sum = 0;
  let multiplier = 2;

  for (const digit of [...body].reverse()) {
    sum += Number(digit) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = sum % 11;
  return remainder === 0 ? "0" : remainder === 1 ? "K" : String(11 - remainder);
}

/** Deserialize any accepted RUT spelling into the canonical storage form. */
export function parseRut(input: unknown): string {
  if (typeof input !== "string") {
    throw new RutError("RUT must be a string");
  }

  const match = RUT_PATTERN.exec(input.trim());

  if (!match) {
    throw new RutError(
      "RUT must contain 7 or 8 digits (no leading zero) and a verification digit",
    );
  }

  const body = match[1].replaceAll(".", "");
  const verificationDigit = match[2].toUpperCase();

  if (verificationDigit !== verificationDigitFor(body)) {
    throw new RutError("RUT verification digit is invalid");
  }

  return `${body}${verificationDigit}`;
}

export function isValidRut(input: unknown): boolean {
  try {
    parseRut(input);
    return true;
  } catch {
    return false;
  }
}

/** Serialize a canonical RUT into the API form ("19034790-7"). */
export function formatRut(canonical: string): string {
  return `${canonical.slice(0, -1)}-${canonical.slice(-1)}`;
}
