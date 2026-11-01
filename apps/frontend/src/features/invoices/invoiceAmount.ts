// Amounts are whole CLP pesos. The text is parsed character by character
// (never parseFloat or Number on the raw text), so «12.50» can not be read as
// 12.5 nor «12.500» as 12.5.

/** Largest amount the API stores (PostgreSQL Int). */
export const MAX_AMOUNT_PESOS = 2_147_483_647;

export type AmountFailure =
  "empty" | "format" | "decimal" | "negative" | "zero" | "max";

export type AmountParse =
  { ok: true; pesos: number } | { ok: false; failure: AmountFailure };

const fail = (failure: AmountFailure): AmountParse => ({ ok: false, failure });

// 1 to 3 digits (the first one not zero) followed by dot-separated groups of
// exactly 3: «12.500». «0.500» is a half, not five hundred.
const GROUPED = /^[1-9]\d{0,2}(?:\.\d{3})+$/;
// The same shape led by zeros: a decimal number, unless it is plain zero.
const ZERO_LED_GROUPED = /^0+(?:\.\d{3})+$/;
const PLAIN = /^\d+$/;
// A comma, or a dot followed by one or two digits at the end: «12,5», «12.50».
const DECIMAL = /^\d[\d.]*,\d*$|^\d+\.\d{1,2}$/;
// Longer than the maximum can not be a valid amount; also keeps Number exact.
const MAX_DIGITS = String(MAX_AMOUNT_PESOS).length;

/**
 * Pesos in the text: digits with optional Chilean thousands dots, an optional
 * leading «$» and surrounding spaces. Decimals, signs, zero and anything above
 * the API maximum are refused with the reason.
 */
export function parseAmountPesos(text: string): AmountParse {
  const trimmed = text.trim();
  const unsigned = trimmed.startsWith("$") ? trimmed.slice(1).trim() : trimmed;
  if (unsigned === "") return fail("empty");
  if (unsigned.startsWith("-")) return fail("negative");
  if (DECIMAL.test(unsigned)) return fail("decimal");
  if (ZERO_LED_GROUPED.test(unsigned))
    return fail(/[1-9]/.test(unsigned) ? "decimal" : "zero");
  if (!PLAIN.test(unsigned) && !GROUPED.test(unsigned)) return fail("format");
  const digits = unsigned.replaceAll(".", "").replace(/^0+(?=\d)/, "");
  if (digits.length > MAX_DIGITS) return fail("max");
  const pesos = Number(digits);
  if (pesos === 0) return fail("zero");
  return pesos > MAX_AMOUNT_PESOS ? fail("max") : { ok: true, pesos };
}

const MAX_TEXT = new Intl.NumberFormat("es-CL").format(MAX_AMOUNT_PESOS);

const MESSAGES: Record<AmountFailure, string> = {
  empty: "Ingresa el monto de la factura en pesos.",
  format: "Ingresa el monto solo con números, por ejemplo 12500 o 12.500.",
  decimal: "El monto debe ser en pesos enteros, sin decimales.",
  negative: "El monto debe ser mayor que cero.",
  zero: "El monto debe ser mayor que cero.",
  max: `El monto no puede superar $${MAX_TEXT}.`,
};

export const amountFailureMessage = (failure: AmountFailure) =>
  MESSAGES[failure];
