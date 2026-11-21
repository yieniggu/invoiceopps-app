import type { Query } from "@tanstack/react-query";
import { useState } from "react";

export const POLL_FIRST_MS = 2_000;
export const POLL_MAX_MS = 10_000;
export const POLL_GIVE_UP_MS = 120_000;

/**
 * Delay before the next refetch of data that is still settling, given how long
 * the run has lasted: 2 s at first, growing with the run up to 10 s. `false`
 * after ~2 minutes. Pure: the same elapsed time always gives the same answer.
 */
export function pollDelay(elapsedMs: number): number | false {
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed >= POLL_GIVE_UP_MS) return false;
  return Math.min(
    POLL_MAX_MS,
    Math.max(POLL_FIRST_MS, Math.round(elapsed / 2)),
  );
}

interface PollRun {
  scope: string;
  since: number;
}

/**
 * Bounded polling of a query while `isActive(data)` holds (predictions
 * PENDING, deployments CHECKING). `refetchInterval` is a pure function of the
 * query state and of `since`, the instant the current run began, which lives
 * in state and is scoped (an invoice, a context).
 *
 * - The run never begins before this mount: `since` is the later of the
 *   cache's `dataUpdatedAt` and the mount time, so data cached minutes ago
 *   does not give up on the first render.
 * - A failed refetch (`status === "error"`, or an error newer than the data)
 *   stops the timer. `observe` then reports `gaveUp`, so the screen offers
 *   its refresh and the spinner stops instead of retrying forever.
 *
 * `observe` records the run while rendering and reports `gaveUp`; `restart`
 * gives it another full run.
 */
export function useBoundedPolling<TData>(
  scope: string,
  isActive: (data: TData | undefined) => boolean,
) {
  const [run, setRun] = useState<PollRun>();
  // Derived from the hook's own mount (and scope) so the clock is read once,
  // in a lazy initializer or a state adjustment, never on every render.
  const [anchor, setAnchor] = useState(() => ({ scope, at: Date.now() }));
  if (anchor.scope !== scope) setAnchor({ scope, at: Date.now() });
  const mountedAt = anchor.scope === scope ? anchor.at : 0;
  const since = run?.scope === scope ? run.since : undefined;

  const refetchInterval = (query: Query<TData, Error, TData>) => {
    const { data, dataUpdatedAt, errorUpdatedAt, status } = query.state;
    if (!isActive(data)) return false;
    if (status === "error" || errorUpdatedAt > dataUpdatedAt) return false;
    return pollDelay(dataUpdatedAt - (since ?? dataUpdatedAt));
  };

  const observe = (
    data: TData | undefined,
    dataUpdatedAt: number,
    errorUpdatedAt = 0,
  ) => {
    const active = isActive(data);
    // Derived state: adjusted while rendering, as React documents.
    if (active && since === undefined)
      setRun({ scope, since: Math.max(dataUpdatedAt, mountedAt) });
    if (!active && run !== undefined) setRun(undefined);
    const failed = errorUpdatedAt > dataUpdatedAt;
    const gaveUp =
      active &&
      (failed ||
        (since !== undefined && dataUpdatedAt - since >= POLL_GIVE_UP_MS));
    return { active, gaveUp };
  };

  /** A new run starts now (an event handler, so reading the clock is fine). */
  const restart = () => setRun({ scope, since: Date.now() });

  return { refetchInterval, observe, restart };
}
