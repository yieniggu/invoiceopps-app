import {
  type Currency,
  type InvoiceBusinessStatus,
  type InvoiceProcessingStatus,
  type Prisma,
  type PrismaClient,
} from "./generated/prisma/client.js";
import { AuthError } from "./auth.js";
import type { Invoice } from "./features/invoices/types.js";
import type { ResourceContext } from "./resource-context.js";

// The legacy list/detail DTO is exactly the zod Invoice contract.
export type InvoiceDto = Invoice;

type InvoiceRow = {
  id: string;
  businessId: string;
  organizationId: string;
  groupId: string;
  supplierName: string;
  amountPesos: number;
  currency: Currency;
  issuedOn: Date;
  dueOn: Date;
  businessStatus: InvoiceBusinessStatus;
  processingStatus: InvoiceProcessingStatus;
  createdByUserId: string;
  createdAt: Date;
};

export interface InvoiceService {
  listInvoices(
    userId: string,
    context: ResourceContext,
    query: { q: string; cursor?: string; limit: number },
  ): Promise<{ invoices: InvoiceDto[]; nextCursor: string | null }>;
  getInvoice(
    userId: string,
    context: ResourceContext,
    invoiceId: string,
  ): Promise<{ invoice: InvoiceDto }>;
}

function inaccessibleContext() {
  return new AuthError(404, "Invoice not found");
}

export async function authorizeContext(
  prisma: Pick<PrismaClient, "organizationMembership" | "groupMembership">,
  userId: string,
  context: ResourceContext,
) {
  const membership = await prisma.organizationMembership.findUnique({
    where: {
      userId_organizationId: { userId, organizationId: context.organizationId },
    },
    select: { userId: true },
  });
  if (
    !membership ||
    (context.ownerType === "user" && context.ownerId !== userId)
  ) {
    throw inaccessibleContext();
  }
  if (context.ownerType === "group") {
    const groupMembership = await prisma.groupMembership.findFirst({
      where: {
        userId,
        groupId: context.ownerId,
        organizationId: context.organizationId,
      },
      select: { userId: true },
    });
    if (!groupMembership) {
      throw inaccessibleContext();
    }
  }
}

// DATE columns arrive as UTC-midnight Date values; read them with UTC
// accessors so the civil date never shifts with the server time zone.
function civilDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function toInvoiceDto(invoice: InvoiceRow): InvoiceDto {
  return {
    id: invoice.id,
    businessId: invoice.businessId,
    organizationId: invoice.organizationId,
    groupId: invoice.groupId,
    supplierName: invoice.supplierName,
    amountPesos: invoice.amountPesos,
    currency: invoice.currency,
    issuedOn: civilDate(invoice.issuedOn),
    dueOn: civilDate(invoice.dueOn),
    businessStatus: invoice.businessStatus,
    processingStatus: invoice.processingStatus,
    createdByUserId: invoice.createdByUserId,
    createdAt: invoice.createdAt.toISOString(),
  };
}

function encodeCursor(createdAt: Date, id: string) {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
  ).toString("base64url");
}

function decodeCursor(cursor: string) {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as {
      createdAt?: unknown;
      id?: unknown;
    };
    const createdAt =
      typeof parsed.createdAt === "string" ? new Date(parsed.createdAt) : null;
    if (
      !createdAt ||
      Number.isNaN(createdAt.getTime()) ||
      typeof parsed.id !== "string" ||
      !parsed.id
    ) {
      throw new Error("invalid cursor");
    }
    return { createdAt, id: parsed.id };
  } catch {
    throw new AuthError(400, "Invalid invoice cursor");
  }
}

export function createInvoiceService(prisma: PrismaClient): InvoiceService {
  return {
    async listInvoices(userId, context, query) {
      await authorizeContext(prisma, userId, context);
      // P0 has no personal invoices: only group contexts can hold any.
      if (context.ownerType === "user") {
        return { invoices: [], nextCursor: null };
      }
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const filters: Prisma.InvoiceWhereInput[] = [
        {
          organizationId: context.organizationId,
          groupId: context.ownerId,
          deletedAt: null,
        },
      ];
      if (query.q) {
        filters.push({
          OR: [
            { businessId: { contains: query.q, mode: "insensitive" } },
            { supplierName: { contains: query.q, mode: "insensitive" } },
          ],
        });
      }
      if (cursor) {
        filters.push({
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { lt: cursor.id } },
          ],
        });
      }
      const invoices = await prisma.invoice.findMany({
        where: { AND: filters },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
      });
      const page = invoices.slice(0, query.limit);
      const last = page.at(-1);
      return {
        invoices: page.map(toInvoiceDto),
        nextCursor:
          invoices.length > query.limit && last
            ? encodeCursor(last.createdAt, last.id)
            : null,
      };
    },
    async getInvoice(userId, context, invoiceId) {
      await authorizeContext(prisma, userId, context);
      if (context.ownerType === "user") throw inaccessibleContext();
      const invoice = await prisma.invoice.findFirst({
        where: {
          id: invoiceId,
          organizationId: context.organizationId,
          groupId: context.ownerId,
          deletedAt: null,
        },
      });
      if (!invoice) throw inaccessibleContext();
      return { invoice: toInvoiceDto(invoice) };
    },
  };
}
