import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_PRIOR_INVOICES,
  buildPredictRequest,
  loadPriorInvoices,
  resetUnkeyedPriorsWarnings,
  UNKEYED_PRIORS_WARN_INTERVAL_MS,
} from "../src/features/predictions/worker.js";
import { supplierKey } from "../src/supplier-key.js";

// Byte-identical copy of invoiceops-ml/tests/fixtures/feature_vectors.json.
// Pinned by hash because the repositories are checked out independently in CI.
const FIXTURE_SHA256 =
  "4b7d8aa3b5ce0fc876a5e6ef9aa0605d82eae1456e9dddf483d0a7ee6fe801a4";
const fixtureBytes = readFileSync(
  new URL("./fixtures/feature_vectors.json", import.meta.url),
);

interface RawInvoice {
  supplierName: string;
  amountPesos: number;
  issuedOn: string;
  dueOn: string;
  createdAt: string;
  businessStatus: string;
}
interface RawPrior extends RawInvoice {
  decidedAt?: string;
}
interface VectorCase {
  name: string;
  note: string;
  invoice: RawInvoice;
  priors: RawPrior[];
  expected: Record<string, number>;
}
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
  schema: string;
  about: string;
  cases: VectorCase[];
};

const FEATURES = [
  "amount_pesos",
  "payment_term_days",
  "issued_weekday",
  "backdated_days",
  "is_new_supplier",
  "supplier_prior_count",
  "supplier_amount_vs_median",
  "supplier_prior_rejected_ratio",
];

const ORG = "org-1";
const SCOPE = "scope-1";

interface Row {
  id: string;
  organizationId: string;
  scopeKey: string;
  supplierKey: string | null;
  supplierName: string;
  amountPesos: number;
  createdAt: Date;
  businessStatus: string;
  deletedAt: Date | null;
}

/** Minimal in-memory stand-in for the Prisma filters loadPriorInvoices uses. */
function fakePrisma(rows: Row[]) {
  return {
    invoice: {
      findMany: async (args: {
        where: {
          organizationId: string;
          scopeKey: string;
          deletedAt: null;
          createdAt: { lt: Date };
          id: { not: string };
          supplierKey: string | null;
        };
        orderBy: Array<Record<string, "asc" | "desc">>;
        take: number;
      }) => {
        const w = args.where;
        return rows
          .filter(
            (r) =>
              r.organizationId === w.organizationId &&
              r.scopeKey === w.scopeKey &&
              r.deletedAt === null &&
              r.createdAt.getTime() < w.createdAt.lt.getTime() &&
              r.id !== w.id.not &&
              r.supplierKey === w.supplierKey,
          )
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() ||
              (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
          )
          .slice(0, args.take);
      },
    },
  } as unknown as Parameters<typeof loadPriorInvoices>[0];
}

/**
 * The worker scores right after creation, so the statuses it reads are the
 * statuses as of the invoice's createdAt: a prior decided at or after that
 * instant is still PENDING (same rule as contract.py `_status_as_of`).
 */
function statusAsOf(prior: RawPrior, createdAt: Date) {
  if (prior.decidedAt && new Date(prior.decidedAt) >= createdAt) {
    return "PENDING";
  }
  return prior.businessStatus;
}

function toRow(prior: RawPrior, index: number, createdAt: Date): Row {
  const name = prior.supplierName;
  return {
    id: `prior-${String(index).padStart(5, "0")}`,
    organizationId: ORG,
    scopeKey: SCOPE,
    // Alternate keyed and unkeyed (not backfilled) rows: both must match.
    supplierKey: index % 2 === 0 ? supplierKey(name) : null,
    supplierName: name,
    amountPesos: prior.amountPesos,
    createdAt: new Date(prior.createdAt),
    businessStatus: statusAsOf(prior, createdAt),
    deletedAt: null,
  };
}

async function workerPayload(vector: VectorCase) {
  const createdAt = new Date(vector.invoice.createdAt);
  const rows = vector.priors.map((p, i) => toRow(p, i, createdAt));
  const invoiceRow = {
    id: "invoice-under-test",
    organizationId: ORG,
    scopeKey: SCOPE,
    supplierName: vector.invoice.supplierName,
    amountPesos: vector.invoice.amountPesos,
    issuedOn: new Date(vector.invoice.issuedOn),
    dueOn: new Date(vector.invoice.dueOn),
    createdAt,
  };
  const priors = await loadPriorInvoices(fakePrisma(rows), invoiceRow);
  return { request: buildPredictRequest(invoiceRow, priors), rows };
}

describe("shared feature vectors (worker payload)", () => {
  it("uses the pinned shared fixture", () => {
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
      FIXTURE_SHA256,
    );
    expect(fixture.schema).toBe("invoice-features-v2");
    expect(fixture.cases.length).toBeGreaterThanOrEqual(3);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))(
    "sends the fields compute_features uses: %s",
    async (_name, vector) => {
      expect(Object.keys(vector.expected).sort()).toEqual([...FEATURES].sort());
      const createdAt = new Date(vector.invoice.createdAt);
      const { request } = await workerPayload(vector);

      // Evaluated invoice: raw fields only; its own status is never sent.
      expect(request.invoice).toEqual({
        supplierName: vector.invoice.supplierName,
        amountPesos: vector.invoice.amountPesos,
        issuedOn: vector.invoice.issuedOn,
        dueOn: vector.invoice.dueOn,
        createdAt: createdAt.toISOString(),
      });

      // Priors: same supplierKey, createdAt strictly before, statuses as of
      // createdAt passed through unchanged, no decidedAt.
      const key = supplierKey(vector.invoice.supplierName);
      const expectedPriors = vector.priors
        .filter(
          (p) =>
            supplierKey(p.supplierName) === key &&
            new Date(p.createdAt) < createdAt,
        )
        .map((p) => ({
          supplierName: p.supplierName,
          amountPesos: p.amountPesos,
          createdAt: new Date(p.createdAt).toISOString(),
          businessStatus: statusAsOf(p, createdAt),
        }));
      const byCreatedAt = (
        a: { createdAt: string; amountPesos: number },
        b: { createdAt: string; amountPesos: number },
      ) =>
        a.createdAt.localeCompare(b.createdAt) || a.amountPesos - b.amountPesos;
      expect([...request.priorInvoices].sort(byCreatedAt)).toEqual(
        [...expectedPriors].sort(byCreatedAt),
      );
      expect(request.priorInvoices).toHaveLength(
        vector.expected.supplier_prior_count!,
      );
      for (const sent of request.priorInvoices) {
        expect(sent).not.toHaveProperty("decidedAt");
        expect(new Date(sent.createdAt) < createdAt).toBe(true);
        expect(supplierKey(sent.supplierName)).toBe(key);
      }
    },
  );

  it("documents decidedAt: statuses are as of creation, later decisions are not sent", async () => {
    const vector = fixture.cases.find((c) =>
      c.priors.some((p) => p.decidedAt),
    )!;
    const createdAt = new Date(vector.invoice.createdAt);
    const late = vector.priors.find(
      (p) => p.decidedAt && new Date(p.decidedAt) >= createdAt,
    )!;
    const { request } = await workerPayload(vector);
    const sent = request.priorInvoices.find(
      (p) => p.createdAt === new Date(late.createdAt).toISOString(),
    )!;
    // Final status is REJECTED, but it was undecided at createdAt.
    expect(late.businessStatus).toBe("REJECTED");
    expect(sent.businessStatus).toBe("PENDING");
  });

  it("caps priors at MAX_PRIOR_INVOICES, newest first", async () => {
    const invoiceCreatedAt = new Date("2025-06-10T12:00:00Z");
    const total = MAX_PRIOR_INVOICES + 5;
    const rows: Row[] = Array.from({ length: total }, (_, i) => ({
      id: `p-${String(i).padStart(5, "0")}`,
      organizationId: ORG,
      scopeKey: SCOPE,
      supplierKey: "acme ltda",
      supplierName: "Acme Ltda",
      amountPesos: 1000 + i,
      createdAt: new Date(invoiceCreatedAt.getTime() - (total - i) * 60_000),
      businessStatus: "APPROVED",
      deletedAt: null,
    }));
    const priors = await loadPriorInvoices(fakePrisma(rows), {
      id: "inv",
      organizationId: ORG,
      scopeKey: SCOPE,
      supplierName: "ACME  ltda",
      createdAt: invoiceCreatedAt,
    });
    expect(MAX_PRIOR_INVOICES).toBe(5000);
    expect(priors).toHaveLength(MAX_PRIOR_INVOICES);
    expect(priors[0]!.amountPesos).toBe(1000 + total - 1);
    expect(priors.at(-1)!.amountPesos).toBe(1000 + 5);
  });

  describe("unkeyed fallback cap (CR-519)", () => {
    beforeEach(() => resetUnkeyedPriorsWarnings());
    afterEach(() => vi.restoreAllMocks());

    const invoiceCreatedAt = new Date("2025-06-10T12:00:00Z");
    const invoice = {
      id: "inv",
      organizationId: ORG,
      scopeKey: SCOPE,
      supplierName: "Acme Ltda",
      createdAt: invoiceCreatedAt,
    };
    const unkeyedRows = (count: number): Row[] =>
      Array.from({ length: count }, (_, i) => ({
        id: `u-${String(i).padStart(5, "0")}`,
        organizationId: ORG,
        scopeKey: SCOPE,
        supplierKey: null,
        supplierName: "Acme Ltda",
        amountPesos: 1000 + i,
        createdAt: new Date(invoiceCreatedAt.getTime() - (count - i) * 60_000),
        businessStatus: "APPROVED",
        deletedAt: null,
      }));

    it("warns when the unkeyed fallback reaches its cap", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const priors = await loadPriorInvoices(
        fakePrisma(unkeyedRows(MAX_PRIOR_INVOICES + 3)),
        invoice,
      );
      expect(priors).toHaveLength(MAX_PRIOR_INVOICES);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
        level: "warn",
        event: "prediction.unkeyed_priors_capped",
        feature: "predictions",
        invoiceId: "inv",
        organizationId: ORG,
        threshold: MAX_PRIOR_INVOICES,
      });
    });

    it("warns once per scope per interval, again after it, and per scope", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const prisma = fakePrisma([
        ...unkeyedRows(MAX_PRIOR_INVOICES + 3),
        ...unkeyedRows(MAX_PRIOR_INVOICES + 3).map((row) => ({
          ...row,
          id: `o-${row.id}`,
          scopeKey: "other-scope",
        })),
      ]);
      let at = 1_000_000;
      const clock = () => at;
      for (let call = 0; call < 5; call += 1) {
        await loadPriorInvoices(prisma, invoice, clock);
        at += 1_000;
      }
      expect(warn).toHaveBeenCalledTimes(1);

      // Another scope of the same organization has its own budget.
      await loadPriorInvoices(
        prisma,
        { ...invoice, scopeKey: "other-scope" },
        clock,
      );
      expect(warn).toHaveBeenCalledTimes(2);

      at += UNKEYED_PRIORS_WARN_INTERVAL_MS;
      await loadPriorInvoices(prisma, invoice, clock);
      expect(warn).toHaveBeenCalledTimes(3);
    });

    it("stays silent below the cap", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await loadPriorInvoices(
        fakePrisma(unkeyedRows(MAX_PRIOR_INVOICES - 1)),
        invoice,
      );
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
