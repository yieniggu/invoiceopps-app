import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { isApiError } from "../../auth/api/apiError";
import { useIdentityId } from "../../auth/hooks/useSession";
import { apiTokensKey, profileKey } from "../../auth/session/queryKeys";
import { createApiToken } from "../api/apiTokensApi";
import type { ApiToken, ApiTokenInput, IssuedApiToken } from "../types";

interface IssueVariables {
  input: ApiTokenInput;
  /** Which emission this is; a delivery for any other one is dropped. */
  attempt: number;
  identityId: string;
}

/**
 * Emits a token and hands its secret to exactly one place.
 *
 * The secret exists in two spots only: the response inside `mutationFn` and
 * the `issued` state below, which the dialog that shows it reads. The mutation
 * resolves with metadata alone and its variables never hold the secret, so
 * neither cache, nor `onSuccess`, nor the mutation state ever sees it.
 *
 * A delivery needs the emission to still be current: closing the dialog,
 * unmounting (logout) or an identity change bump the attempt counter, so a
 * response that arrives late finds nobody to give the secret to and drops it.
 * When the screen is still there (the dialog was closed), `onAbandoned` tells
 * it that a token exists whose secret nobody saw.
 */
export function useIssueApiToken({
  onAbandoned,
}: {
  /**
   * An emission whose dialog was closed before the answer succeeded: the token
   * exists but nobody was given its secret. Receives its metadata, never the
   * secret.
   */
  onAbandoned?: (token: ApiToken) => void;
} = {}) {
  const client = useQueryClient();
  const identityId = useIdentityId();
  const [issued, setIssued] = useState<IssuedApiToken>();
  const current = useRef(0);
  const currentIdentity = useRef(identityId);
  const abandoned = useRef(onAbandoned);
  const deliver = useRef<
    | ((
        attempt: number,
        identity: string,
        value: IssuedApiToken,
      ) => "delivered" | "abandoned" | "gone")
    | null
  >(null);

  useEffect(() => {
    abandoned.current = onAbandoned;
  }, [onAbandoned]);

  useEffect(() => {
    currentIdentity.current = identityId;
    deliver.current = (attempt, identity, value) => {
      if (currentIdentity.current !== identity) return "gone";
      if (current.current !== attempt) return "abandoned";
      setIssued(value);
      return "delivered";
    };
    return () => {
      deliver.current = null;
      current.current += 1;
    };
  }, [identityId]);

  const mutation = useMutation({
    mutationKey: ["api-tokens", "issue"],
    mutationFn: async ({
      input,
      attempt,
      identityId: identity,
    }: IssueVariables): Promise<ApiToken> => {
      const { token, secret } = await createApiToken(input);
      const outcome = deliver.current?.(attempt, identity, { token, secret });
      if (outcome === "abandoned") abandoned.current?.(token);
      return token;
    },
    onSuccess: () =>
      client.invalidateQueries({ queryKey: apiTokensKey(identityId) }),
    onError: (error) => {
      if (isApiError(error) && error.status === 403)
        void client.invalidateQueries({ queryKey: profileKey(identityId) });
    },
  });

  const { mutate, reset } = mutation;
  const issue = useCallback(
    (input: ApiTokenInput) => {
      current.current += 1;
      mutate({ input, attempt: current.current, identityId });
    },
    [mutate, identityId],
  );
  /** Drops the secret, cancels delivery of one in flight and clears the mutation. */
  const discard = useCallback(() => {
    current.current += 1;
    setIssued(undefined);
    reset();
  }, [reset]);

  return {
    issue,
    discard,
    issued,
    pending: mutation.isPending,
    error: mutation.error,
    isError: mutation.isError,
  };
}
