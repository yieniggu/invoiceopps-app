/** Validation of the demo knobs of playwright.config.ts (pure, tested). */

/** `RPA_DEMO_HEADLESS`: 1/0/true/false; unset or empty means headed. */
export function parseDemoHeadless(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false;
  const value = raw.toLowerCase();
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(
    `RPA_DEMO_HEADLESS must be 1, 0, true or false, got "${raw}"`,
  );
}

/** `RPA_DEMO_SLOWMO`: whole milliseconds; defaults to 250 headed and 0 headless. */
export function parseDemoSlowMo(
  raw: string | undefined,
  headless: boolean,
): number {
  if (raw === undefined || raw === "") return headless ? 0 : 250;
  if (!/^\d+$/.test(raw))
    throw new Error(
      `RPA_DEMO_SLOWMO must be a non-negative integer (milliseconds), got "${raw}"`,
    );
  return Number(raw);
}
