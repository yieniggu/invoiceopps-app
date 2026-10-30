import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { createInvoiceDeleteService } from "../../src/features/invoices/services.js";
import { ApiError } from "../../src/http/errors.js";

// CR-330: the delete service has no retry loop of its own. Conflicts are
// retried by runSerializable and a surfaced unique violation maps to the same
// retryable 503, so the outcome is always a result or a documented error.

const TARGET = {
  invoiceId: "33333333-3333-4333-8333-333333333333",
  organizationId: "11111111-1111-4111-8111-111111111111",
};

function serviceWith(transaction: ReturnType<typeof vi.fn>) {
  const prisma = { $transaction: transaction } as unknown as PrismaClient;
  return createInvoiceDeleteService(prisma);
}

const uniqueViolation = () =>
  Object.assign(new Error("unique"), { code: "P2002" });
const serializationFailure = () =>
  Object.assign(new Error("conflict"), { code: "P2034" });

describe("createInvoiceDeleteService conflict handling (CR-330)", () => {
  it("answers the retryable 503 after one unique violation, without looping", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const transaction = vi.fn().mockRejectedValue(uniqueViolation());

    const outcome = await serviceWith(transaction)
      .deleteInvoice("user-1", TARGET)
      .catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(ApiError);
    expect(outcome).toMatchObject({ status: 503, code: "RETRYABLE_CONFLICT" });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("succeeds when a serialization failure is followed by a clean attempt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(serializationFailure())
      .mockResolvedValueOnce({ deleted: true, groupId: null });

    await expect(
      serviceWith(transaction).deleteInvoice("user-1", TARGET),
    ).resolves.toEqual({ deleted: true, groupId: null });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("answers the retryable 503 when serialization failures exhaust the retries", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const transaction = vi.fn().mockRejectedValue(serializationFailure());

    const outcome = await serviceWith(transaction)
      .deleteInvoice("user-1", TARGET)
      .catch((error: unknown) => error);

    expect(outcome).toMatchObject({ status: 503, code: "RETRYABLE_CONFLICT" });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it("answers the retryable 503 on an interactive transaction timeout (P2028)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const transaction = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("timeout"), { code: "P2028" }),
      );

    const outcome = await serviceWith(transaction)
      .deleteInvoice("user-1", TARGET)
      .catch((error: unknown) => error);

    expect(outcome).toMatchObject({ status: 503, code: "RETRYABLE_CONFLICT" });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
