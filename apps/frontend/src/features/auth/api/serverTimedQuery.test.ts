import type { UseQueryResult } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { ServerTimed } from "./apiRequest";
import { unwrapServerTimed } from "./serverTimedQuery";

interface Page {
  total: number;
}

/** A query result whose properties count their reads, like a tracked one. */
function trackedResult(data: ServerTimed<Page> | undefined) {
  const reads: string[] = [];
  const values: Record<string, unknown> = {
    data,
    isPending: false,
    isError: false,
    isFetching: true,
    dataUpdatedAt: 1_000,
    refetch: async () => ({ data }),
  };
  const result = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(result, key, {
      enumerable: true,
      get: () => {
        reads.push(key);
        return value;
      },
    });
  return {
    result: result as unknown as UseQueryResult<ServerTimed<Page>>,
    reads,
  };
}

describe("unwrapServerTimed", () => {
  it("exposes the DTO as data and the server clock beside it", () => {
    const { result } = trackedResult({ body: { total: 3 }, serverNow: 42 });
    const query = unwrapServerTimed(result);
    expect(query.data).toEqual({ total: 3 });
    expect(query.serverNow).toBe(42);
    expect(query.dataUpdatedAt).toBe(1_000);
  });

  it("has neither data nor a clock before the first answer", () => {
    const { result } = trackedResult(undefined);
    const query = unwrapServerTimed(result);
    expect(query.data).toBeUndefined();
    expect(query.serverNow).toBeUndefined();
  });

  it("reads only the properties the screen uses, so tracking stays narrow", () => {
    const { result, reads } = trackedResult({
      body: { total: 3 },
      serverNow: 42,
    });
    const query = unwrapServerTimed(result);
    void query.data;
    void query.isPending;
    expect(reads).toEqual(["data", "isPending"]);
  });

  it("offers refetch without a typed result to read from", async () => {
    const { result } = trackedResult({ body: { total: 3 }, serverNow: 42 });
    const query = unwrapServerTimed(result);
    const refetched = await query.refetch();
    // @ts-expect-error: the refetch result is the envelope, never the DTO.
    void refetched.data;
    // @ts-expect-error: the experimental promise is not exposed either.
    void query.promise;
  });
});
