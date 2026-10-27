import { QueryClientProvider } from "@tanstack/react-query";
import { useSyncExternalStore, type ReactNode } from "react";

import { SessionContext } from "../hooks/useSession";
import type { SessionStore } from "../session/sessionStore";

/**
 * Renders the current QueryClient partition. The provider is keyed by the
 * partition generation, so the previous identity's tree is unmounted in the
 * same commit that mounts the next one: no frame mixes two identities.
 */
export function SessionProvider({
  store,
  children,
}: {
  store: SessionStore;
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return (
    <SessionContext.Provider value={{ store, snapshot }}>
      <QueryClientProvider client={snapshot.client} key={snapshot.generation}>
        {children}
      </QueryClientProvider>
    </SessionContext.Provider>
  );
}
