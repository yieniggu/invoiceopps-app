// Chilean RUT helpers. API form: "19034790-7". Display/input form:
// "19.034.790-7". Mirrors apps/backend/src/rut.ts.
//
// Layout decision (RV-097): `src/lib` and `src/components` are the shared
// layer for code used by more than one feature (RUT helpers, RutField). Domain
// code lives under `src/features/<feature>/{api,components,hooks,screens,types}`.
const MAX_SIGNIFICANT_CHARS = 9;

/** Keep only digits and K, uppercased. */
export function cleanRut(value: string): string {
  return value.replace(/[^0-9kK]/g, "").toUpperCase();
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

/** Progressive formatting while typing: dotted body, dash, last character. */
export function formatRutInput(value: string): string {
  // K is only meaningful as the verification digit (the last character).
  // Leading zeros are dropped so the body never starts with 0 (the canonical
  // form is unique); K only makes sense as the last character.
  const cleaned = cleanRut(value)
    .replace(/K(?=.)/g, "")
    .replace(/^0+/, "")
    .slice(0, MAX_SIGNIFICANT_CHARS);

  if (cleaned.length < 2) {
    return cleaned;
  }

  const body = cleaned.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${body}-${cleaned.slice(-1)}`;
}

function removedOnlySeparator(previous: string, raw: string): boolean {
  if (raw.length !== previous.length - 1) {
    return false;
  }

  return [...previous].some(
    (character, index) =>
      /[.-]/.test(character) &&
      previous.slice(0, index) + previous.slice(index + 1) === raw,
  );
}

/**
 * Next input value for a change event. Deleting only a separator would be
 * reformatted straight back, so that case removes the last significant char.
 */
export function nextRutInputValue(previous: string, raw: string): string {
  if (removedOnlySeparator(previous, raw)) {
    return formatRutInput(cleanRut(previous).slice(0, -1));
  }

  return formatRutInput(raw);
}

/**
 * Caret position in `formatted` that sits after the same significant
 * characters (digits and K) the caret followed in `raw`. Separators and
 * dropped leading zeros do not count, so editing mid-value keeps the caret
 * next to the character the person was editing.
 */
export function caretAfterFormat(
  raw: string,
  rawCaret: number,
  formatted: string,
): number {
  const before = cleanRut(raw.slice(0, rawCaret)).length;
  const leadingZeros = /^0*/.exec(cleanRut(raw))?.[0].length ?? 0;
  const significant = Math.max(0, before - Math.min(leadingZeros, before));
  if (significant === 0) return 0;

  let seen = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (/[0-9K]/.test(formatted[index])) {
      seen += 1;
      if (seen === significant) return index + 1;
    }
  }
  return formatted.length;
}

export function isValidRut(value: string): boolean {
  const cleaned = cleanRut(value);
  const match = /^([1-9]\d{6,7})([0-9K])$/.exec(cleaned);

  return match !== null && match[2] === verificationDigitFor(match[1]);
}

/** Serialize to the API form ("19034790-7"). */
export function toApiRut(value: string): string {
  const cleaned = cleanRut(value);
  return cleaned.length < 2
    ? cleaned
    : `${cleaned.slice(0, -1)}-${cleaned.slice(-1)}`;
}

/** Deserialize an API value (canonical or dashed) into the display form. */
export function fromApiRut(value: string): string {
  return formatRutInput(value);
}
