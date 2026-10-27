import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { isUnauthorized } from "../api/apiError";

/**
 * Mutations flagged `meta: { sensitive: true }` carry credentials in their
 * variables. They leave the MutationCache the moment they settle so a
 * finished login or password change never keeps a password in memory.
 */
export function createQueryClient({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}) {
  const reportUnauthorized = (error: unknown) => {
    if (isUnauthorized(error)) onUnauthorized();
  };
  const mutationCache: MutationCache = new MutationCache({
    onError: reportUnauthorized,
    onSettled: (_data, _error, _variables, _onMutateResult, mutation) => {
      if (mutation.meta?.sensitive) mutationCache.remove(mutation);
    },
  });
  return new QueryClient({
    queryCache: new QueryCache({ onError: reportUnauthorized }),
    mutationCache,
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}
