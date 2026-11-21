import type { PrismaClient } from "./generated/prisma/client.js";
import { logEvent } from "./http/logging.js";
import { supplierKey } from "./supplier-key.js";

/**
 * Fills `Invoice.supplierKey` for rows that have none (rows that predate the
 * column, or inserted by an older release during a rolling deploy/rollback).
 * Idempotent and resumable: it only touches rows whose key is NULL, in keyset
 * batches, and the UPDATE re-checks `supplierKey IS NULL`, so concurrent runs
 * (several replicas starting together) and re-runs are harmless.
 *
 * The key cannot be computed in SQL (it is defined in JS/Python, see
 * supplier-key.ts), hence a startup task instead of a SQL-only migration.
 *
 * `signal` (the shutdown signal) stops it between batches: it returns what it
 * updated so far, and the next start resumes (only NULL keys are touched).
 */
export async function backfillSupplierKeys(
  prisma: PrismaClient,
  options: { batchSize?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? 1000;
  let updated = 0;
  let after = "";
  for (;;) {
    if (options.signal?.aborted) return updated;
    const rows = await prisma.invoice.findMany({
      where: { supplierKey: null, id: { gt: after } },
      select: { id: true, supplierName: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (rows.length === 0) return updated;
    after = rows[rows.length - 1]!.id;
    const ids = rows.map((row) => row.id);
    const keys = rows.map((row) => supplierKey(row.supplierName));
    updated += await prisma.$executeRaw`
      UPDATE "Invoice" AS i SET "supplierKey" = v."key"
      FROM (SELECT unnest(${ids}::text[]) AS "id", unnest(${keys}::text[]) AS "key") AS v
      WHERE i."id" = v."id" AND i."supplierKey" IS NULL`;
  }
}

/**
 * The startup run: logs what it backfilled and, on failure, a
 * `supplier_key.backfill_failed` error. Never throws. A failure while the
 * shutdown signal is aborted (the pool closing under it) is expected and not
 * logged. Resolves true when the backfill ran to the end.
 */
export async function runStartupSupplierKeyBackfill(
  prisma: PrismaClient,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const updated = await backfillSupplierKeys(prisma, { signal });
    if (updated > 0) {
      logEvent("info", "supplier_key.backfilled", {
        reason: `updated=${updated}`,
      });
    }
    return !signal.aborted;
  } catch (error) {
    if (!signal.aborted) {
      logEvent("error", "supplier_key.backfill_failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return false;
  }
}
