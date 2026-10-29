import { describe, expect, it } from "vitest";

import { mapWithConcurrency, normalizeIds } from "./pagination";

describe("mapWithConcurrency", () => {
  it("never has more than the limit in flight and keeps the result order", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency(
      Array.from({ length: 12 }, (_unused, index) => index),
      4,
      async (item) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5 - (item % 4)));
        inFlight -= 1;
        return item * 2;
      },
    );
    expect(peak).toBe(4);
    expect(results).toEqual(Array.from({ length: 12 }, (_u, i) => i * 2));
  });

  it("starts nothing more after a failure and rejects with it", async () => {
    let started = 0;
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 2, async (item) => {
        started += 1;
        if (item === 2) throw new Error("boom");
        await new Promise((resolve) => setTimeout(resolve, 5));
        return item;
      }),
    ).rejects.toThrow("boom");
    expect(started).toBeLessThan(8);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe("normalizeIds", () => {
  it("sorts and de-duplicates, so equal sets share one query key", () => {
    expect(normalizeIds(["b", "a", "b", "c", "a"])).toEqual(["a", "b", "c"]);
    expect(normalizeIds([])).toEqual([]);
  });
});
