import { describe, expect, it, vi } from "vitest";

import { type AuthUser } from "../src/auth.js";
import {
  createInvoiceService,
  type InvoiceDecisionInput,
} from "../src/invoices.js";
import {
  InvoiceStatus,
  type PrismaClient,
} from "../src/generated/prisma/client.js";

const actor: AuthUser = {
  id: "user-1",
  name: "Ada Lovelace",
  rut: "123456785",
};
const context = {
  organizationId: "organization-1",
  ownerType: "user" as const,
  ownerId: actor.id,
};
const probabilityInput: InvoiceDecisionInput = {
  mode: "PROBABILITY_POLICY",
  policyVersion: "ml-policy-v1",
};

function createPrisma({
  invoiceStatus,
  policy,
  hidePendingInvoice = false,
}: {
  invoiceStatus: InvoiceStatus;
  policy: { manualReviewThreshold: { toNumber(): number } } | null;
  hidePendingInvoice?: boolean;
}) {
  const invoice = {
    id: "invoice-1",
    invoiceId: "INV-001",
    organizationId: context.organizationId,
    ownerType: "USER",
    ownerId: actor.id,
    status: invoiceStatus,
  };
  const transaction = {
    invoice: {
      findFirst: vi.fn().mockResolvedValue(invoice),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    businessPolicy: { findFirst: vi.fn().mockResolvedValue(policy) },
    decisionEvent: { create: vi.fn() },
  };

  return {
    organizationMembership: {
      findUnique: vi.fn().mockResolvedValue({ userId: actor.id }),
    },
    groupMembership: { findFirst: vi.fn() },
    invoice: {
      findFirst: vi.fn(({ where }) =>
        Promise.resolve(
          hidePendingInvoice && where.status === InvoiceStatus.PENDING
            ? null
            : invoice,
        ),
      ),
    },
    businessPolicy: { findFirst: vi.fn().mockResolvedValue(policy) },
    $transaction: vi.fn(async (callback) => callback(transaction)),
  } as unknown as PrismaClient;
}

describe("PROBABILITY_POLICY local validation", () => {
  it("returns 409 for an already decided invoice without invoking predict", async () => {
    const prisma = createPrisma({
      invoiceStatus: InvoiceStatus.MANUAL_REVIEW,
      policy: { manualReviewThreshold: { toNumber: () => 0.8 } },
      hidePendingInvoice: true,
    });
    const predict = vi.fn().mockResolvedValue({
      modelId: "invoice-review",
      modelVersion: "1",
      runId: "run-1",
      probability: 0.2,
    });
    const invoices = createInvoiceService(prisma, { predict });

    await expect(
      invoices.decideInvoice(actor, context, "INV-001", probabilityInput),
    ).rejects.toMatchObject({ status: 409 });

    expect(predict).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing policy without invoking predict", async () => {
    const prisma = createPrisma({
      invoiceStatus: InvoiceStatus.PENDING,
      policy: null,
    });
    const predict = vi.fn().mockResolvedValue({
      modelId: "invoice-review",
      modelVersion: "1",
      runId: "run-1",
      probability: 0.2,
    });
    const invoices = createInvoiceService(prisma, { predict });

    await expect(
      invoices.decideInvoice(actor, context, "INV-001", probabilityInput),
    ).rejects.toMatchObject({ status: 404 });

    expect(predict).not.toHaveBeenCalled();
  });
});
