import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import type { IssuedCredential } from "../types";
import { TemporaryPasswordDialog } from "./TemporaryPasswordDialog";

type Present = (
  credential: IssuedCredential,
  returnFocusTo?: RefObject<HTMLElement | null>,
) => void;

const IssuedCredentialContext = createContext<Present | undefined>(undefined);

/**
 * Owns the one-time temporary-password dialog above the routes, so a response
 * that arrives after the person left the provisioning screen still shows it.
 * The secret lives in this component's memory only: never in Query or Mutation
 * caches, never persisted. Mount it keyed by identity: a logout or identity
 * swap unmounts it, which drops the secret and turns late deliveries into
 * no-ops.
 */
export function IssuedCredentialProvider({
  children,
}: {
  children: ReactNode;
}) {
  // Credentials wait their turn: a second one never replaces one the person
  // has not confirmed yet (each is shown once and cannot be recovered).
  const [queue, setQueue] = useState<
    Array<{
      id: number;
      credential: IssuedCredential;
      returnFocusTo?: RefObject<HTMLElement | null>;
    }>
  >([]);
  const issued = queue[0];
  const nextId = useRef(0);
  const present = useCallback<Present>((credential, returnFocusTo) => {
    const id = nextId.current++;
    setQueue((waiting) => [...waiting, { id, credential, returnFocusTo }]);
  }, []);

  return (
    <IssuedCredentialContext.Provider value={present}>
      {children}
      {issued ? (
        <TemporaryPasswordDialog
          key={issued.id}
          credential={issued.credential}
          onClose={() => setQueue((waiting) => waiting.slice(1))}
          returnFocusTo={issued.returnFocusTo}
        />
      ) : null}
    </IssuedCredentialContext.Provider>
  );
}

export function usePresentIssuedCredential() {
  const present = useContext(IssuedCredentialContext);
  if (!present)
    throw new Error("IssuedCredentialProvider is missing from the tree");
  return present;
}
