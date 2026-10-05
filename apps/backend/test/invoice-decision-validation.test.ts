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
import { createModelApiClient } from "../src/model-api-client.js";

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

  it("audits a foreign model response as manual-review fallback without model metadata", async () => {
    const invoice = {
      id: "invoice-1",
      invoiceId: "INV-001",
      status: InvoiceStatus.PENDING,
      invoiceAmountCents: 125_000,
      vendorTenureDays: 365,
      previousIncidents12m: 1,
      amountVsVendorMedian: 1.25,
      hasPurchaseOrder: true,
      threeWayMatch: true,
      bankAccountRecentlyChanged: false,
      countryRisk: "low",
      updatedAt: new Date("2026-09-21T00:01:00.000Z"),
    };
    const policy = {
      version: "ml-policy-v1",
      manualReviewThreshold: { toNumber: () => 0.8 },
    };
    const createEvent = vi.fn(async ({ data }) => ({
      ...data,
      manualReviewThreshold: { toNumber: () => data.manualReviewThreshold },
      actorName: actor.name,
      actorRut: actor.rut,
      createdAt: new Date("2026-09-21T00:01:00.000Z"),
    }));
    const transaction = {
      invoice: {
        findFirst: vi.fn().mockResolvedValue(invoice),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          ...invoice,
          status: InvoiceStatus.MANUAL_REVIEW,
        }),
      },
      businessPolicy: { findFirst: vi.fn().mockResolvedValue(policy) },
      decisionEvent: { create: createEvent },
    };
    const prisma = {
      organizationMembership: {
        findUnique: vi.fn().mockResolvedValue({ userId: actor.id }),
      },
      invoice: { findFirst: vi.fn().mockResolvedValue(invoice) },
      businessPolicy: { findFirst: vi.fn().mockResolvedValue(policy) },
      $transaction: vi.fn(async (callback) => callback(transaction)),
    } as unknown as PrismaClient;
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model_id: "other-model",
          model_version: "7",
          run_id: "foreign-run",
          probability: 0.1,
        }),
        { status: 200 },
      ),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = createInvoiceService(
        prisma,
        createModelApiClient({
          baseUrl: "http://model-api.test",
          modelId: "invoice-review",
          fetch,
        }),
      );

      const result = await service.decideInvoice(
        actor,
        context,
        "INV-001",
        probabilityInput,
      );

      expect(fetch).toHaveBeenCalledOnce();
      expect(result.invoice.status).toBe(InvoiceStatus.MANUAL_REVIEW);
      expect(result.auditEvent).toMatchObject({
        decision: "MANUAL_REVIEW",
        recommendation: "MANUAL_REVIEW",
        policyProbabilitySource: "MODEL_API_FALLBACK",
        policyProbability: null,
        modelId: null,
        modelVersion: null,
        modelRunId: null,
      });
      expect(createEvent).toHaveBeenCalledWith({
        data: expect.objectContaining({
          policyProbabilitySource: "MODEL_API_FALLBACK",
          policyProbability: null,
          modelId: null,
          modelVersion: null,
          modelRunId: null,
        }),
      });
      expect(errorLog).toHaveBeenCalledWith("Model API inference failed", {
        invoiceId: "INV-001",
      });
    } finally {
      errorLog.mockRestore();
    }
  });
});
