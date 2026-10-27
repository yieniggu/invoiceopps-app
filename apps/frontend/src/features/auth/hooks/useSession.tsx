import { createContext, useContext } from "react";

import type { SessionSnapshot, SessionStore } from "../session/sessionStore";

export interface SessionValue {
  store: SessionStore;
  snapshot: SessionSnapshot;
}

export const SessionContext = createContext<SessionValue | null>(null);

function useSessionValue() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("SessionProvider is required");
  return value;
}

export const useSessionStore = () => useSessionValue().store;
export const useSessionSnapshot = () => useSessionValue().snapshot;

/** Identity id of the authenticated partition. Only valid below the gate. */
export function useIdentityId() {
  const { identityId } = useSessionSnapshot();
  if (!identityId) throw new Error("No authenticated identity");
  return identityId;
}
