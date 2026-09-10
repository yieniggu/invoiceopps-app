const RUT_PATTERN = /^(\d{7,8})([0-9K])$/;

export function normalizeRut(value: string): string {
  const rut = value.replace(/[.\-\s]/g, "").toUpperCase();
  const match = RUT_PATTERN.exec(rut);

  if (!match) {
    throw new Error("RUT must contain 7 or 8 digits and a verification digit");
  }

  const [, body, verificationDigit] = match;
  let sum = 0;
  let multiplier = 2;

  for (const digit of [...body].reverse()) {
    sum += Number(digit) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = sum % 11;
  const expectedDigit =
    remainder === 0 ? "0" : remainder === 1 ? "K" : String(11 - remainder);

  if (verificationDigit !== expectedDigit) {
    throw new Error("RUT verification digit is invalid");
  }

  return rut;
}

export function normalizeSlug(value: string): string {
  const slug = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!slug) {
    throw new Error("Organization slug must contain letters or digits");
  }

  return slug;
}
