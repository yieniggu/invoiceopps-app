import { useMutation, useQueryClient } from "@tanstack/react-query";

import { isUnauthorized } from "../api/apiError";
import {
  requestChangePassword,
  requestLogin,
  requestLogout,
} from "../api/authApi";
import { LOGOUT_KEY } from "./useProfile";
import { useSessionStore } from "./useSession";

/** Credentials go in variables; `sensitive` drops them when the call settles. */
export function useLoginMutation() {
  return useMutation({
    mutationFn: requestLogin,
    meta: { sensitive: true },
  });
}

/**
 * A new password rotates the server session: start a fresh partition. With
 * `onChanged` the person stays on the current route (it runs just before the
 * rotation, which remounts every screen); without it they return to the panel.
 */
export function useChangePasswordMutation({
  onChanged,
}: { onChanged?: () => void } = {}) {
  const store = useSessionStore();
  const client = useQueryClient();
  return useMutation({
    mutationFn: requestChangePassword,
    meta: { sensitive: true },
    onSuccess: () => {
      // Before the rotation: it remounts every screen below the store.
      onChanged?.();
      store.begin(client, { keepRoute: onChanged !== undefined });
    },
  });
}

export function useLogoutMutation() {
  const store = useSessionStore();
  const client = useQueryClient();
  return useMutation({
    mutationKey: LOGOUT_KEY,
    mutationFn: requestLogout,
    // In-flight reads belong to the identity that is leaving: cancel them,
    // remembering which ones in case the logout fails.
    onMutate: async () => {
      const cancelled = client
        .getQueryCache()
        .findAll({ fetchStatus: "fetching" })
        .map((query) => query.queryKey);
      await client.cancelQueries();
      return cancelled;
    },
    onSuccess: () => store.end(client, "logout"),
    // A failed logout keeps the identity, but cancelled reads need a new try.
    onError: (error, _variables, cancelled) => {
      if (isUnauthorized(error)) return;
      for (const queryKey of cancelled ?? [])
        void client.invalidateQueries({ queryKey, exact: true });
    },
  });
}
