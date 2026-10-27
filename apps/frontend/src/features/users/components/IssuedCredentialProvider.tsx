import {
  createContext,
  useCallback,
  useContext,
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
  const [issued, setIssued] = useState<{
    credential: IssuedCredential;
    returnFocusTo?: RefObject<HTMLElement | null>;
  }>();
  const present = useCallback<Present>(
    (credential, returnFocusTo) => setIssued({ credential, returnFocusTo }),
    [],
  );

  return (
    <IssuedCredentialContext.Provider value={present}>
      {children}
      {issued ? (
        <TemporaryPasswordDialog
          credential={issued.credential}
          onClose={() => setIssued(undefined)}
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
