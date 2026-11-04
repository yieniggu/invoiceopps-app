// Expiry of an API token: presets or a date, never beyond what this screen
// offers. The server accepts an instant strictly in the future and at most 30
// days ahead (checked when the request arrives); the screen offers at most 29,
// the one day of margin that absorbs a clock on this device that runs ahead of
// the server's. Every limit shown or enforced here is that 29, so the copy,
// the presets, the date picker and the value sent all agree. (A date picked in
// the field is capped at 29 calendar days, which a daylight-saving change can
// stretch to 29 days and 1 hour: still inside the server's 30.)

import { formatInstant } from "../../lib/datetime";

/** The longest expiry offered, in days (the server's own limit is 30). */
export const MAX_EXPIRY_DAYS = 29;
export type ExpiryChoice = "7" | "29" | "custom";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const civilDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * The same wall-clock time 29 calendar days ahead, not 29 × 24 h: a
 * daylight-saving change in between makes a span of days 23 or 25 hours long,
 * which would move the civil day.
 */
const lastExpiryInstant = (now: Date) => {
  const last = new Date(now.getTime());
  last.setDate(last.getDate() + MAX_EXPIRY_DAYS);
  return last;
};

/**
 * Earliest and latest civil dates (`YYYY-MM-DD`) the date field accepts. The
 * latest is the day of lastExpiryInstant, and a date picked there is clamped
 * to that same instant, so it never lands on the day before.
 */
export const expiryBounds = (now: Date = new Date()) => ({
  min: civilDate(now),
  max: civilDate(lastExpiryInstant(now)),
});

/** The instant cut down to its minute: what the screen previews and sends. */
export const floorToMinute = (date: Date) =>
  new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);

export type ExpiryResult = { expiresAt: string } | { error: string };

export function resolveExpiry(
  { choice, date }: { choice: ExpiryChoice; date: string },
  now: Date = new Date(),
): ExpiryResult {
  if (choice !== "custom") {
    const limit = now.getTime() + MAX_EXPIRY_DAYS * DAY_MS;
    const target = now.getTime() + Number(choice) * DAY_MS;
    return { expiresAt: new Date(Math.min(target, limit)).toISOString() };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const endOfDay = match
    ? new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        23,
        59,
        59,
      )
    : undefined;
  if (!match || !endOfDay || civilDate(endOfDay) !== date)
    return { error: "Elige una fecha de caducidad." };
  const { min, max } = expiryBounds(now);
  if (date < min || endOfDay.getTime() <= now.getTime())
    return { error: "La fecha de caducidad ya pasó." };
  if (date > max)
    return {
      error: `La caducidad no puede superar los ${MAX_EXPIRY_DAYS} días.`,
    };
  const limit = lastExpiryInstant(now).getTime();
  return {
    expiresAt: new Date(Math.min(endOfDay.getTime(), limit)).toISOString(),
  };
}

/** «Vence el …» for the expiry the person is about to send, or nothing yet. */
export function describeExpiry(
  choice: { choice: ExpiryChoice; date: string },
  now: Date = new Date(),
): string | undefined {
  const result = resolveExpiry(choice, now);
  return "expiresAt" in result
    ? `Vence el ${formatInstant(result.expiresAt)}`
    : undefined;
}
