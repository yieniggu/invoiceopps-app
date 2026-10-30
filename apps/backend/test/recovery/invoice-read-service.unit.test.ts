import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { createInvoiceReadService } from "../../src/features/invoices/services.js";
import { ApiError } from "../../src/http/errors.js";

// CR-328: a read transaction that times out (Prisma P2028) answers the same
// retryable 503 as the writes instead of an unexpected 500.

const ORG = "11111111-1111-4111-8111-111111111111";
const INVOICE_ID = "33333333-3333-4333-8333-333333333333";

function serviceFailingWith(code: string) {
  const transaction = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error("failure"), { code }));
  const prisma = { $transaction: transaction } as unknown as PrismaClient;
  return { service: createInvoiceReadService(prisma), transaction };
}

describe("createInvoiceReadService transaction failures (CR-328)", () => {
  it("maps a list transaction timeout to the retryable 503", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service, transaction } = serviceFailingWith("P2028");

    const outcome = await service
      .listInvoices("user-1", {
        organizationId: ORG,
        ungrouped: false,
        page: 1,
        pageSize: 20,
      })
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(ApiError);
    expect(outcome).toMatchObject({ status: 503, code: "RETRYABLE_CONFLICT" });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("maps a detail transaction timeout to the retryable 503", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service } = serviceFailingWith("P2028");

    const outcome = await service
      .getInvoice("user-1", { invoiceId: INVOICE_ID, organizationId: ORG })
      .catch((error: unknown) => error);

    expect(outcome).toMatchObject({ status: 503, code: "RETRYABLE_CONFLICT" });
  });

  it("does not hide an unrelated failure", async () => {
    const { service } = serviceFailingWith("P1001");

    const outcome = await service
      .getInvoice("user-1", { invoiceId: INVOICE_ID, organizationId: ORG })
      .catch((error: unknown) => error);

    expect(outcome).not.toBeInstanceOf(ApiError);
  });
});
