import { useEffect, useState } from "react";
import { useLocation } from "react-router";

import type { RouteNotice } from "./paths";

/** The message on screen and the identity of its arrival. */
export interface ActiveNotice {
  message: string | undefined;
  /** Changes with every arrival, even of the same text. */
  id: string;
}

/**
 * The one-shot message the previous screen handed over through navigation
 * state. It is shown for as long as this screen stays mounted, and it is
 * removed from `history.state` right away: a reload, or Back to this entry, no
 * longer replays it.
 *
 * The entry is rewritten with `history.replaceState` rather than a router
 * `navigate(..., { replace: true })`: a router navigation would cancel one the
 * person started meanwhile (a link followed as the screen appeared), and the
 * router already has the notice in memory for this render. The router's own
 * keys in `history.state` are kept.
 */
export function useRouteNotice(): ActiveNotice {
  const location = useLocation();
  const incoming = (location.state as RouteNotice | null)?.notice;
  const [active, setActive] = useState<ActiveNotice>({
    message: incoming,
    id: location.key,
  });
  // A newer notice can arrive while the screen is mounted (same route again).
  // Each arrival is its own navigation entry, so its key tells an identical
  // text arriving a second time from a re-render of the first.
  if (incoming !== undefined && location.key !== active.id)
    setActive({ message: incoming, id: location.key });

  useEffect(() => {
    if (incoming === undefined) return;
    const stored = window.history.state as {
      usr?: RouteNotice | null;
    } | null;
    // Only the entry that carried the notice: never one the person has
    // already moved on to.
    if (
      window.location.pathname === location.pathname &&
      stored?.usr?.notice === incoming
    )
      window.history.replaceState({ ...stored, usr: null }, "");
    // Only the arrival of a notice matters, not later location changes (the
    // key tells a repeated identical text from a re-render).
  }, [incoming, location.key]);

  return active;
}
