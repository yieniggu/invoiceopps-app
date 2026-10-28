import { useCallback, useEffect, useRef } from "react";

/**
 * Carries a secret from the form to the request without making it a mutation
 * variable: the form `stage`s it just before `mutate`, the mutation function
 * `read`s it when it builds the request, and the form `clear`s it once the
 * mutation settles. It lives in a ref, so it never enters the MutationCache,
 * the QueryCache or any storage, and unmounting drops it.
 */
export function useSecretOutbox() {
  const secret = useRef<string | undefined>(undefined);
  useEffect(
    () => () => {
      secret.current = undefined;
    },
    [],
  );
  const stage = useCallback((value: string | undefined) => {
    secret.current = value;
  }, []);
  const read = useCallback(() => secret.current, []);
  const clear = useCallback(() => {
    secret.current = undefined;
  }, []);
  return { stage, read, clear };
}
