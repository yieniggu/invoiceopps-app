import {
  MutationCache,
  QueryCache,
  QueryClient,
  type QueryClientConfig,
} from "@tanstack/react-query";

import { isUnauthorized } from "../api/apiError";

/**
 * The cache of one session partition. Once the partition is retired it keeps
 * nothing new: a query built afterwards is handed back to its observer but is
 * never stored.
 */
class PartitionQueryCache extends QueryCache {
  retired = false;

  override add(query: Parameters<QueryCache["add"]>[0]) {
    if (!this.retired) super.add(query);
  }
}

/**
 * A QueryClient that can be retired. Retiring cancels in-flight reads and
 * drops both caches (as before) and then makes the client inert for good:
 * React flushes the passive effects of the last commit of the previous
 * identity's tree lazily, so an observer of that tree can call `setOptions`
 * after the swap. Without this, that call rebuilt queries in the retired cache
 * and started their requests (a stale profile and group read of the person who
 * just left, observed once in a few runs under load).
 */
class PartitionQueryClient extends QueryClient {
  #retired = false;

  constructor(config: QueryClientConfig) {
    super(config);
    const defaultQueryOptions = this.defaultQueryOptions.bind(this);
    // A retired partition fetches nothing, whatever its observers ask for.
    this.defaultQueryOptions = ((options) => {
      const defaulted = defaultQueryOptions(options);
      return this.#retired ? { ...defaulted, enabled: false } : defaulted;
    }) as QueryClient["defaultQueryOptions"];
  }

  retire() {
    this.#retired = true;
    (this.getQueryCache() as PartitionQueryCache).retired = true;
    void this.cancelQueries();
    this.clear();
  }
}

/** Retires a session client: cancel, clear, and refuse anything new. */
export function retireQueryClient(client: QueryClient) {
  if (client instanceof PartitionQueryClient) {
    client.retire();
    return;
  }
  void client.cancelQueries();
  client.clear();
}

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
  const config: QueryClientConfig = {
    queryCache: new PartitionQueryCache({ onError: reportUnauthorized }),
    mutationCache,
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  };
  return new PartitionQueryClient(config);
}
