import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { isUnauthorized } from "../api/apiError";
import { requestProfile } from "../api/authApi";
import { onOnboardingRequired } from "../api/protectedFetch";
import { profileKey, sessionProfileKey } from "../session/queryKeys";
import { useSessionSnapshot, useSessionStore } from "./useSession";

export const LOGOUT_KEY = ["auth", "logout"] as const;

/**
 * The profile is the only query that can run before the identity is known:
 * it uses the ephemeral session key, and once it answers the store adopts
 * the identity partition (or swaps it when another person answers).
 */
export function useProfileQuery() {
  const store = useSessionStore();
  const { client, phase, identityId } = useSessionSnapshot();
  return useQuery({
    queryKey: identityId ? profileKey(identityId) : sessionProfileKey,
    queryFn: async () => {
      try {
        const profile = await requestProfile();
        store.accept(client, profile);
        return profile;
      } catch (error) {
        if (isUnauthorized(error)) store.end(client);
        throw error;
      }
    },
    enabled: phase !== "anonymous",
    staleTime: 30_000,
    refetchOnWindowFocus: "always",
  });
}

/**
 * A protected call answered 403 ONBOARDING_REQUIRED (the temporary password
 * became pending while the page was open): refetch the profile so the forced
 * password-change screen replaces the generic permission message.
 */
export function useOnboardingReload() {
  const client = useQueryClient();
  const { identityId } = useSessionSnapshot();
  // External subscription (module-level transport listener), not data fetching.
  useEffect(
    () =>
      onOnboardingRequired(() => {
        // Read at call time: a logout that just started must win the race.
        if (!identityId || client.isMutating({ mutationKey: LOGOUT_KEY }) > 0)
          return;
        void client.invalidateQueries(
          { queryKey: profileKey(identityId) },
          { cancelRefetch: false },
        );
      }),
    [client, identityId],
  );
}
