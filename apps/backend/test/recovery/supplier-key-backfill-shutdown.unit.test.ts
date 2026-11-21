import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  backfillSupplierKeys,
  runStartupSupplierKeyBackfill,
} from "../../src/supplier-key-backfill.js";

afterEach(() => vi.restoreAllMocks());

/** Three batches of one row each; `onBatch` runs after each batch is read. */
function prismaStub(options: {
  onBatch?: (batch: number) => void;
  failOn?: number;
}) {
  const rows = ["a", "b", "c"].map((id) => ({ id, supplierName: "ACME SpA" }));
  let reads = 0;
  const prisma = {
    invoice: {
      findMany: vi.fn(async (args: { where: { id: { gt: string } } }) => {
        const next = rows.filter((row) => row.id > args.where.id.gt);
        const batch = next.slice(0, 1);
        reads += 1;
        options.onBatch?.(reads);
        if (options.failOn === reads) throw new Error("pool closed");
        return batch;
      }),
    },
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma: prisma as unknown as PrismaClient, stub: prisma };
}

describe("supplier key backfill and shutdown", () => {
  it("stops between batches once the signal aborts and returns the progress", async () => {
    const controller = new AbortController();
    const { prisma, stub } = prismaStub({
      onBatch: (batch) => {
        if (batch === 1) controller.abort();
      },
    });

    const updated = await backfillSupplierKeys(prisma, {
      batchSize: 1,
      signal: controller.signal,
    });

    // Batch 1 was already read and is written; batch 2 never starts.
    expect(updated).toBe(1);
    expect(stub.invoice.findMany).toHaveBeenCalledTimes(1);
  });

  it("does not log backfill_failed when the failure comes after SIGTERM", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const { prisma } = prismaStub({
      onBatch: () => controller.abort(),
      failOn: 1,
    });

    const finished = await runStartupSupplierKeyBackfill(
      prisma,
      controller.signal,
    );

    expect(finished).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it("still logs backfill_failed for a real failure and a clean run reports completion", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = prismaStub({ failOn: 1 });
    expect(
      await runStartupSupplierKeyBackfill(
        failing.prisma,
        new AbortController().signal,
      ),
    ).toBe(false);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      '"event":"supplier_key.backfill_failed"',
    );

    const clean = prismaStub({});
    expect(
      await runStartupSupplierKeyBackfill(
        clean.prisma,
        new AbortController().signal,
      ),
    ).toBe(true);
  });
});
