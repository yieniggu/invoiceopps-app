import { z } from "zod";

const MAX_AMOUNT_PESOS = 2_147_483_647;

const InvoiceId = z.uuid();
const businessId = z.string().trim().min(1).max(80);
const supplierName = z.string().trim().min(1).max(200);
// CLP in whole pesos (never cents); PostgreSQL Int.
const amountPesos = z.int().min(1).max(MAX_AMOUNT_PESOS);
const currency = z.enum(["CLP"]);
const civilDate = z.iso.date();
const businessStatus = z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);

export const InvoiceCreateRequestSchema = z
  .object({
    organizationId: z.uuid(),
    groupId: z.uuid(),
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
    groupId: z.uuid(),
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

// Legacy read inputs (RP0-11 owns the final shape); not published in OpenAPI
// because they carry no `id` meta and no operation references them.
export const ResourceContextSchema = z.object({
  organizationId: z.string().min(1),
  ownerType: z.enum(["user", "group"]),
  ownerId: z.string().min(1),
});

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export const InvoiceListOptionsSchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    cursor: z.string().min(1).optional(),
    // Number() semantics are kept on purpose (" 5 " and "1e1" are accepted).
    limit: z
      .unknown()
      .optional()
      .transform((value, context) => {
        if (value === undefined) return DEFAULT_PAGE_SIZE;
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
          context.addIssue({
            code: "custom",
            message: `The limit must be an integer between 1 and ${MAX_PAGE_SIZE}`,
          });
          return z.NEVER;
        }
        return limit;
      }),
  })
  .transform(({ q, cursor, limit }) => ({ q: q ?? "", cursor, limit }));
