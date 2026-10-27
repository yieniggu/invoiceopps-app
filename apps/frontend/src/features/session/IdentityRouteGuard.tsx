import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";

import type { SessionStore } from "../auth/session/sessionStore";
import { paths } from "../navigation/paths";

/**
 * A person leaving the session (logout, 401) or another one taking over must
 * not inherit the previous URL: the location returns to the panel in the same
 * commit that swaps the partition. Rendered outside the keyed provider so it
 * survives every partition change.
 */
export function IdentityRouteGuard({ store }: { store: SessionStore }) {
  const { identityId } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
  );
  const navigate = useNavigate();
  const previous = useRef<string | null>(null);

  // Router synchronisation with an external store, not data fetching.
  useLayoutEffect(() => {
    if (previous.current && previous.current !== identityId) {
      navigate(paths.panel, { replace: true });
    }
    previous.current = identityId;
  }, [identityId, navigate]);

  return null;
}
