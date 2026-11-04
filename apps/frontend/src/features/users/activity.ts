const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * How recent the last activity is: under a day, under a week, older, or never.
 * The screen paints it green, yellow, red or gray, always next to the text.
 */
export type ActivityTone = "day" | "week" | "stale" | "never";

export interface Activity {
  tone: ActivityTone;
  label: string;
}

/**
 * «Activo hace …» for `lastActiveAt` as seen at `now` (epoch ms). Pure: the
 * caller passes the reference instant (the moment the data was fetched), so
 * the label is stable during a render and refreshes with the query.
 */
export function describeActivity(
  lastActiveAt: string | null,
  now: number,
): Activity {
  const at = lastActiveAt === null ? Number.NaN : Date.parse(lastActiveAt);
  if (Number.isNaN(at)) return { tone: "never", label: "Nunca" };
  // A timestamp ahead of the reference (clock skew) reads as «just now».
  const elapsed = Math.max(0, now - at);
  const tone: ActivityTone =
    elapsed < DAY ? "day" : elapsed < WEEK ? "week" : "stale";
  if (elapsed < MINUTE) return { tone, label: "Activo hace menos de 1 min" };
  if (elapsed < HOUR)
    return { tone, label: `Activo hace ${Math.floor(elapsed / MINUTE)} min` };
  if (elapsed < DAY)
    return { tone, label: `Activo hace ${Math.floor(elapsed / HOUR)} h` };
  return { tone, label: `Activo hace ${Math.floor(elapsed / DAY)} d` };
}

/**
 * How often the people lists and profiles refetch while on screen, so
 * «Activo hace …» keeps up with time without a timer of its own. It matches
 * the server's write throttle: activity never moves faster than this.
 */
export const ACTIVITY_REFRESH_MS = 5 * MINUTE;

/** Returning to the tab refetches only data at least this old. */
export const ACTIVITY_FOCUS_MIN_AGE_MS = MINUTE;

/**
 * Query options shared by every read that shows «Activo hace …»: a refetch
 * every ACTIVITY_REFRESH_MS while mounted (never in a hidden tab), and on
 * window focus once the data is a minute old, so quick tab switches do not
 * each cost a request.
 */
export const ACTIVITY_REFETCH = {
  refetchInterval: ACTIVITY_REFRESH_MS,
  refetchOnWindowFocus: (query: { state: { dataUpdatedAt: number } }) =>
    Date.now() - query.state.dataUpdatedAt >= ACTIVITY_FOCUS_MIN_AGE_MS,
} as const;
