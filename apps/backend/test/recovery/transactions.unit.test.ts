import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../../src/http/errors.js";
import { runSerializable } from "../../src/transactions.js";

function rawQueryFailure(originalCode: string) {
  return Object.assign(new Error("raw query failed"), {
    code: "P2010",
    meta: { driverAdapterError: { cause: { originalCode } } },
  });
}

function adapterFailure(originalCode: string) {
  return Object.assign(new Error("TransactionWriteConflict"), {
    name: "DriverAdapterError",
    cause: { originalCode, kind: "TransactionWriteConflict" },
  });
}

describe("runSerializable conflict detection", () => {
  it.each([
    ["a driver adapter serialization failure (40001)", adapterFailure("40001")],
    ["a driver adapter deadlock (40P01)", adapterFailure("40P01")],
    [
      "a Prisma write conflict (P2034)",
      Object.assign(new Error("c"), { code: "P2034" }),
    ],
    ["a raw query serialization failure (40001)", rawQueryFailure("40001")],
    ["a raw query deadlock (40P01)", rawQueryFailure("40P01")],
  ])("retries %s and succeeds on the next attempt", async (_label, failure) => {
    let attempts = 0;
    const result = await runSerializable(async () => {
      attempts += 1;
      if (attempts === 1) throw failure;
      return "done";
    });
    expect(result).toBe("done");
    expect(attempts).toBe(2);
  });

  it("answers a retryable 503 after three conflicted attempts", async () => {
    let attempts = 0;
    const outcome = await runSerializable(async () => {
      attempts += 1;
      throw rawQueryFailure("40001");
    }).catch((error: unknown) => error);
    expect(attempts).toBe(3);
    expect(outcome).toBeInstanceOf(ApiError);
    expect(outcome).toMatchObject({ status: 503, code: "RETRYABLE_CONFLICT" });
  });

  it.each([
    ["a raw query with another SQLSTATE", rawQueryFailure("23505")],
    [
      "a raw query error without a driver code",
      Object.assign(new Error("x"), { code: "P2010" }),
    ],
    ["a driver adapter error with another SQLSTATE", adapterFailure("23505")],
    ["an unrelated error", new Error("boom")],
  ])("does not retry %s", async (_label, failure) => {
    let attempts = 0;
    await expect(
      runSerializable(async () => {
        attempts += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });
});

describe("runSerializable backoff and timeouts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function recordDelays() {
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      delay?: number,
    ) => {
      delays.push(delay ?? 0);
      callback();
      return 0;
    }) as unknown as typeof setTimeout);
    return delays;
  }

  it("pauses 10-50 ms between attempts, never after the last one", async () => {
    const delays = recordDelays();
    await runSerializable(async () => {
      throw rawQueryFailure("40001");
    }).catch(() => undefined);
    // Three attempts leave two gaps.
    expect(delays).toHaveLength(2);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(10);
      expect(delay).toBeLessThanOrEqual(50);
    }
  });

  it("jitters: the lower and upper random bounds map to 10 and 50 ms", async () => {
    const delays = recordDelays();
    const random = vi.spyOn(Math, "random");
    random.mockReturnValueOnce(0).mockReturnValueOnce(0.999999);
    await runSerializable(async () => {
      throw rawQueryFailure("40P01");
    }).catch(() => undefined);
    expect(delays[0]).toBe(10);
    expect(delays[1]).toBeCloseTo(50, 3);
  });

  it("does not pause when the first attempt succeeds", async () => {
    const delays = recordDelays();
    await expect(runSerializable(async () => "ok")).resolves.toBe("ok");
    expect(delays).toEqual([]);
  });

  it("maps a Prisma transaction timeout (P2028) to a retryable 503 without repeating", async () => {
    recordDelays();
    let attempts = 0;
    const outcome = await runSerializable(async () => {
      attempts += 1;
      throw Object.assign(new Error("Transaction already closed"), {
        code: "P2028",
      });
    }).catch((error: unknown) => error);
    expect(attempts).toBe(1);
    expect(outcome).toBeInstanceOf(ApiError);
    expect(outcome).toMatchObject({
      status: 503,
      code: "RETRYABLE_CONFLICT",
      headers: { "Retry-After": "1" },
    });
  });
});
