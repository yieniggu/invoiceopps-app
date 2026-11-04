import type { UseQueryResult } from "@tanstack/react-query";

import type { ServerTimed } from "./apiRequest";

/**
 * A query whose `data` is the plain DTO, with the server's clock beside it.
 * `refetch` resolves to nothing usable on purpose (its result would still be
 * the `{ body, serverNow }` envelope), and the experimental `promise` is left
 * out for the same reason: read `data` and `serverNow` instead.
 */
export type ServerTimedQuery<T> = Omit<
  UseQueryResult<T>,
  "refetch" | "promise"
> & {
  refetch: () => Promise<unknown>;
  /** The server's clock for `data`; undefined while there is no data. */
  serverNow: number | undefined;
};

/**
 * Unwraps a query cached as `{ body, serverNow }`: screens read `data` as the
 * DTO the server sent and `serverNow` apart from it. Every other property is
 * read lazily from the original result, so React Query still tracks only the
 * properties a screen actually uses and re-renders on those alone.
 */
export function unwrapServerTimed<T>(
  query: UseQueryResult<ServerTimed<T>>,
): ServerTimedQuery<T> {
  return new Proxy(query, {
    get(target, property, receiver) {
      if (property === "data") return target.data?.body;
      if (property === "serverNow") return target.data?.serverNow;
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as ServerTimedQuery<T>;
}
