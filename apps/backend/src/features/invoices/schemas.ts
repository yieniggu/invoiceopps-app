import { z } from "zod";

import {
  paginationQueryShape,
  paginationResponseShape,
} from "../../pagination.js";
import { hasNoNul, NO_NUL } from "../../text.js";

const MAX_AMOUNT_PESOS = 2_147_483_647;

const InvoiceId = z.uuid();
const businessId = z.string().trim().min(1).max(80);
const supplierName = z.string().trim().min(1).max(200);
// CLP in whole pesos (never cents); PostgreSQL Int.
const amountPesos = z.int().min(1).max(MAX_AMOUNT_PESOS);
const currency = z.enum(["CLP"]);
const civilDate = z.iso.date();
// An omitted or null groupId is the organization scope, normalized to null.
const scopeGroupId = z.uuid().nullable().default(null);
const businessStatus = z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);

/** Opaque client-generated key of a retryable write (Idempotency-Key header). */
export const IdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/, "Expected 16 to 128 of A-Z a-z 0-9 _ -");

export const IdempotencyKeyHeaderSchema = z.object({
  "Idempotency-Key": IdempotencyKeySchema,
});

export const InvoiceCreateRequestSchema = z
  .object({
    organizationId: z.uuid(),
    groupId: scopeGroupId,
    businessId,
    supplierName,
    amountPesos,
    currency,
    issuedOn: civilDate,
    dueOn: civilDate,
    businessStatus,
  })
  .strict()
  .refine((invoice) => invoice.dueOn >= invoice.issuedOn, {
    path: ["dueOn"],
    message: "dueOn must not be earlier than issuedOn",
  })
  .meta({
    id: "InvoiceCreateRequest",
    description: "Invoice creation body. Server-only fields are rejected.",
    examples: [
      {
        organizationId: "11111111-1111-4111-8111-111111111111",
        groupId: "22222222-2222-4222-8222-222222222222",
        businessId: "FAC-2026-001",
        supplierName: "Proveedor local",
        amountPesos: 12500,
        currency: "CLP",
        issuedOn: "2026-10-25",
        dueOn: "2026-11-25",
        businessStatus: "PENDING",
      },
    ],
  });

export const InvoiceSchema = z
  .object({
    id: InvoiceId,
    organizationId: z.uuid(),
    groupId: z.uuid().nullable(),
    businessId,
    supplierName,
    amountPesos,
    currency,
    issuedOn: civilDate,
    dueOn: civilDate,
    businessStatus,
    processingStatus: z.enum(["NOT_REQUESTED"]),
    createdByUserId: z.uuid(),
    createdAt: z.iso.datetime(),
  })
  .meta({
    id: "Invoice",
    description:
      "Invoice DTO built explicitly, never spread from a database row.",
    examples: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        organizationId: "11111111-1111-4111-8111-111111111111",
        groupId: "22222222-2222-4222-8222-222222222222",
        businessId: "FAC-2026-001",
        supplierName: "Proveedor local",
        amountPesos: 12500,
        currency: "CLP",
        issuedOn: "2026-10-25",
        dueOn: "2026-11-25",
        businessStatus: "PENDING",
        processingStatus: "NOT_REQUESTED",
        createdByUserId: "44444444-4444-4444-8444-444444444444",
        createdAt: "2026-10-25T12:00:00.000Z",
      },
    ],
  });

export const InvoiceResponseSchema = z
  .object({ invoice: InvoiceSchema })
  .meta({ id: "InvoiceResponse", description: "Envelope of one invoice." });

/**
 * Read DTO of GET /invoices and GET /invoices/{invoiceId}: the Invoice plus the
 * name of its group (null in the organization scope). The create response and
 * the stored idempotency snapshots keep the plain Invoice contract.
 */
export const InvoiceViewSchema = InvoiceSchema.extend({
  groupName: z.string().nullable(),
}).meta({
  id: "InvoiceView",
  description:
    "Invoice as read: the Invoice fields plus groupName, the name of its group (null in the organization scope).",
  examples: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      organizationId: "11111111-1111-4111-8111-111111111111",
      groupId: "22222222-2222-4222-8222-222222222222",
      groupName: "Finanzas",
      businessId: "FAC-2026-001",
      supplierName: "Proveedor local",
      amountPesos: 12500,
      currency: "CLP",
      issuedOn: "2026-10-25",
      dueOn: "2026-11-25",
      businessStatus: "PENDING",
      processingStatus: "NOT_REQUESTED",
      createdByUserId: "44444444-4444-4444-8444-444444444444",
      createdAt: "2026-10-25T12:00:00.000Z",
    },
  ],
});

export const InvoiceViewResponseSchema = z
  .object({ invoice: InvoiceViewSchema })
  .meta({
    id: "InvoiceViewResponse",
    description: "Envelope of one invoice as read.",
  });

const ungrouped = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .default(false);

export const InvoiceListQuerySchema = z
  .object({
    organizationId: z.uuid(),
    groupId: z.uuid().optional(),
    ungrouped: ungrouped.meta({
      description:
        "true lists only invoices outside any group; incompatible with groupId",
    }),
    businessStatus: businessStatus.optional(),
    issuedFrom: civilDate.optional().meta({
      description: "Inclusive lower bound of issuedOn (YYYY-MM-DD)",
    }),
    issuedTo: civilDate.optional().meta({
      description: "Inclusive upper bound of issuedOn (YYYY-MM-DD)",
    }),
    q: z.string().trim().max(120).refine(hasNoNul, NO_NUL).optional().meta({
      description:
        "Case-insensitive part of the businessId or the supplierName",
    }),
    ...paginationQueryShape,
  })
  .strict()
  .refine((query) => !(query.groupId !== undefined && query.ungrouped), {
    path: ["ungrouped"],
    message: "ungrouped=true cannot be combined with groupId",
  })
  .refine(
    (query) =>
      query.issuedFrom === undefined ||
      query.issuedTo === undefined ||
      query.issuedFrom <= query.issuedTo,
    {
      path: ["issuedTo"],
      message: "issuedTo must not be earlier than issuedFrom",
    },
  )
  .meta({ id: "InvoiceListQuery" });

export const InvoiceTargetQuerySchema = z
  .object({
    organizationId: z.uuid(),
    groupId: z.uuid().optional().meta({
      description:
        "Context check: when given it must be the group of the invoice",
    }),
  })
  .strict()
  .meta({ id: "InvoiceTargetQuery" });

export const InvoiceParamsSchema = z.object({ invoiceId: InvoiceId });

export const InvoicePageSchema = z
  .object({ items: z.array(InvoiceViewSchema), ...paginationResponseShape })
  .meta({
    id: "InvoicePage",
    description: "One page of invoices, newest first.",
    examples: [
      {
        items: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            organizationId: "11111111-1111-4111-8111-111111111111",
            groupId: "22222222-2222-4222-8222-222222222222",
            groupName: "Finanzas",
            businessId: "FAC-2026-001",
            supplierName: "Proveedor local",
            amountPesos: 12500,
            currency: "CLP",
            issuedOn: "2026-10-25",
            dueOn: "2026-11-25",
            businessStatus: "PENDING",
            processingStatus: "NOT_REQUESTED",
            createdByUserId: "44444444-4444-4444-8444-444444444444",
            createdAt: "2026-10-25T12:00:00.000Z",
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      },
    ],
  });
