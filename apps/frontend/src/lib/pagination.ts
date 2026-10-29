/** Paging limits the server enforces on every paginated list. */

/** The largest page the server serves. */
export const MAX_PAGE_SIZE = 100;
/** The deepest page the server accepts (anything above answers 400). */
export const MAX_PAGE = 10_000;

/** Query string of a request: `undefined` values are dropped, arrays join by comma. */
export function withQuery(path: string, params: object) {
  const query = new URLSearchParams(
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  return `${path}?${query}`;
}

/** Splits a list into runs of at most `size` items. */
export function inChunks<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    chunks.push(items.slice(start, start + size));
  return chunks;
}

/** Requests in flight at once when one logical read needs several. */
export const MAX_CONCURRENT_REQUESTS = 4;

/**
 * Like `Promise.all(items.map(task))` but with at most `limit` tasks running
 * at once; the results keep the order of `items`. After a failure nothing new
 * is started and the first error is thrown.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** Sorted and de-duplicated: equal sets of ids share one query key. */
export function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}
