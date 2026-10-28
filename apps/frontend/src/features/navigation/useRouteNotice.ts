import { useEffect, useState } from "react";
import { useLocation } from "react-router";

import type { RouteNotice } from "./paths";

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
export function useRouteNotice(): string | undefined {
  const location = useLocation();
  const incoming = (location.state as RouteNotice | null)?.notice;
  const [notice, setNotice] = useState(incoming);
  // A newer notice can arrive while the screen is mounted (same route again).
  if (incoming !== undefined && incoming !== notice) setNotice(incoming);

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
    // Only the arrival of a notice matters, not later location changes.
  }, [incoming]);

  return notice;
}
