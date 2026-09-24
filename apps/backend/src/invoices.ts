import { randomUUID } from "node:crypto";

import {
  InvoiceStatus,
  type Prisma,
  ResourceOwnerType,
  type PrismaClient,
} from "./generated/prisma/client.js";
import { AuthError, type AuthUser } from "./auth.js";
import type { ResourceContext } from "./resources.js";

export const RULE_VERSION = "invoice-rules-v1";
export const AUTO_PROCESS_LIMIT_CENTS = 500_000;
export const LOCAL_DEMONSTRATION = "LOCAL_DEMONSTRATION";

export type InvoiceDecision = "AUTO_PROCESS" | "MANUAL_REVIEW";
export type InvoiceDecisionInput =
  { mode: "RULE_V1" } | { mode: "PROBABILITY_POLICY"; policyVersion: string };
type CountryRisk = "low" | "medium" | "high";

type InvoiceListItem = {
  invoiceId: string;
  vendorName: string;
  invoiceAmountCents: number;
  hasPurchaseOrder: boolean;
  threeWayMatch: boolean;
  status: InvoiceStatus;
  policyProbability: number | null;
  policyProbabilitySource: string | null;
};

type InvoiceDetail = InvoiceListItem & {
  riskContext: {
    vendorTenureDays: number;
    previousIncidents12m: number;
    bankAccountRecentlyChanged: boolean;
    amountVsVendorMedian: number;
    countryRisk: CountryRisk;
  };
  createdAt: string;
  updatedAt: string;
};

export interface InvoiceService {
  listInvoices(
    userId: string,
    context: ResourceContext,
    query: { q: string; cursor?: string; limit: number },
  ): Promise<{ invoices: InvoiceListItem[]; nextCursor: string | null }>;
  getInvoice(
    userId: string,
    context: ResourceContext,
    invoiceId: string,
  ): Promise<{ invoice: InvoiceDetail; auditEvents: AuditEvent[] }>;
  decideInvoice(
    actor: AuthUser,
    context: ResourceContext,
    invoiceId: string,
    input: InvoiceDecisionInput,
  ): Promise<{
    invoice: { invoiceId: string; status: InvoiceStatus; updatedAt: string };
    auditEvent: AuditEvent;
  }>;
}

export type AuditEvent = {
  decision: InvoiceDecision;
  ruleVersion: string;
  mode: "RULE_V1" | "PROBABILITY_POLICY";
  policyVersion: string | null;
  manualReviewThreshold: number | null;
  policyProbability: number | null;
  policyProbabilitySource: string | null;
  actor: { name: string; rut: string };
  correlationId: string;
  createdAt: string;
};

function inaccessibleContext() {
  return new AuthError(404, "Invoice not found");
}

function ownerType(owner: ResourceContext["ownerType"]) {
  return owner === "user" ? ResourceOwnerType.USER : ResourceOwnerType.GROUP;
}

async function authorizeContext(
  prisma: PrismaClient,
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

function toListItem(invoice: {
  invoiceId: string;
  vendorName: string;
  invoiceAmountCents: number;
  hasPurchaseOrder: boolean;
  threeWayMatch: boolean;
  status: InvoiceStatus;
  policyProbability: { toNumber(): number } | null;
  policyProbabilitySource: string | null;
}): InvoiceListItem {
  return {
    ...invoice,
    policyProbability: invoice.policyProbability?.toNumber() ?? null,
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

function expectedDecision(invoice: {
  invoiceAmountCents: number;
  hasPurchaseOrder: boolean;
  threeWayMatch: boolean;
}): InvoiceDecision {
  return invoice.invoiceAmountCents <= AUTO_PROCESS_LIMIT_CENTS &&
    invoice.hasPurchaseOrder &&
    invoice.threeWayMatch
    ? "AUTO_PROCESS"
    : "MANUAL_REVIEW";
}

function auditEventResponse(event: {
  decision: string;
  ruleVersion: string;
  mode: string;
  policyVersion: string | null;
  manualReviewThreshold: { toNumber(): number } | null;
  policyProbability: { toNumber(): number } | null;
  policyProbabilitySource: string | null;
  actorName: string;
  actorRut: string;
  correlationId: string;
  createdAt: Date;
}): AuditEvent {
  return {
    decision: event.decision as InvoiceDecision,
    ruleVersion: event.ruleVersion,
    mode: event.mode as AuditEvent["mode"],
    policyVersion: event.policyVersion,
    manualReviewThreshold: event.manualReviewThreshold?.toNumber() ?? null,
    policyProbability: event.policyProbability?.toNumber() ?? null,
    policyProbabilitySource: event.policyProbabilitySource,
    actor: { name: event.actorName, rut: event.actorRut },
    correlationId: event.correlationId,
    createdAt: event.createdAt.toISOString(),
  };
}

export function createInvoiceService(prisma: PrismaClient): InvoiceService {
  return {
    async listInvoices(userId, context, query) {
      await authorizeContext(prisma, userId, context);
      const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
      const filters: Prisma.InvoiceWhereInput[] = [
        {
          organizationId: context.organizationId,
          ownerType: ownerType(context.ownerType),
          ownerId: context.ownerId,
        },
      ];
      if (query.q) {
        filters.push({
          OR: [
            { invoiceId: { contains: query.q, mode: "insensitive" } },
            { vendorName: { contains: query.q, mode: "insensitive" } },
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
        invoices: page.map(toListItem),
        nextCursor:
          invoices.length > query.limit && last
            ? encodeCursor(last.createdAt, last.id)
            : null,
      };
    },
    async getInvoice(userId, context, invoiceId) {
      await authorizeContext(prisma, userId, context);
      const invoice = await prisma.invoice.findFirst({
        where: {
          organizationId: context.organizationId,
          ownerType: ownerType(context.ownerType),
          ownerId: context.ownerId,
          invoiceId,
        },
        include: {
          decisionEvents: { orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
        },
      });
      if (!invoice) throw inaccessibleContext();
      return {
        invoice: {
          ...toListItem(invoice),
          riskContext: {
            vendorTenureDays: invoice.vendorTenureDays,
            previousIncidents12m: invoice.previousIncidents12m,
            bankAccountRecentlyChanged: invoice.bankAccountRecentlyChanged,
            amountVsVendorMedian: invoice.amountVsVendorMedian,
            countryRisk: invoice.countryRisk as CountryRisk,
          },
          createdAt: invoice.createdAt.toISOString(),
          updatedAt: invoice.updatedAt.toISOString(),
        },
        auditEvents: invoice.decisionEvents.map(auditEventResponse),
      };
    },
    async decideInvoice(actor, context, invoiceId, input) {
      await authorizeContext(prisma, actor.id, context);
      return prisma.$transaction(async (transaction) => {
        const invoice = await transaction.invoice.findFirst({
          where: {
            organizationId: context.organizationId,
            ownerType: ownerType(context.ownerType),
            ownerId: context.ownerId,
            invoiceId,
          },
        });
        if (!invoice) throw inaccessibleContext();
        if (invoice.status !== InvoiceStatus.PENDING) {
          throw new AuthError(409, "Invoice decision is not permitted");
        }
        const policy =
          input.mode === "PROBABILITY_POLICY"
            ? await transaction.businessPolicy.findFirst({
                where: {
                  organizationId: context.organizationId,
                  ownerType: ownerType(context.ownerType),
                  ownerId: context.ownerId,
                  version: input.policyVersion,
                },
              })
            : null;
        if (input.mode === "PROBABILITY_POLICY" && !policy) {
          throw new AuthError(404, "Business policy not found");
        }
        if (
          input.mode === "PROBABILITY_POLICY" &&
          (invoice.policyProbability === null ||
            invoice.policyProbabilitySource !== LOCAL_DEMONSTRATION)
        ) {
          throw new AuthError(409, "Invoice probability is not available");
        }
        const probability = invoice.policyProbability?.toNumber() ?? null;
        const threshold = policy?.manualReviewThreshold.toNumber() ?? null;
        const decision =
          input.mode === "RULE_V1"
            ? expectedDecision(invoice)
            : probability! >= threshold!
              ? "MANUAL_REVIEW"
              : "AUTO_PROCESS";
        const status =
          decision === "AUTO_PROCESS"
            ? InvoiceStatus.AUTO_PROCESSED
            : InvoiceStatus.MANUAL_REVIEW;
        const updated = await transaction.invoice.updateMany({
          where: { id: invoice.id, status: InvoiceStatus.PENDING },
          data: { status },
        });
        if (updated.count !== 1)
          throw new AuthError(409, "Invoice decision is not permitted");
        const event = await transaction.decisionEvent.create({
          data: {
            invoiceId: invoice.id,
            decision,
            ruleVersion:
              input.mode === "RULE_V1" ? RULE_VERSION : input.policyVersion,
            mode: input.mode,
            policyVersion: policy?.version,
            manualReviewThreshold: threshold,
            policyProbability: probability,
            policyProbabilitySource:
              input.mode === "PROBABILITY_POLICY"
                ? invoice.policyProbabilitySource
                : null,
            actorUserId: actor.id,
            actorName: actor.name,
            actorRut: actor.rut,
            correlationId: randomUUID(),
          },
        });
        const decidedInvoice = await transaction.invoice.findUniqueOrThrow({
          where: { id: invoice.id },
        });
        return {
          invoice: {
            invoiceId: decidedInvoice.invoiceId,
            status: decidedInvoice.status,
            updatedAt: decidedInvoice.updatedAt.toISOString(),
          },
          auditEvent: auditEventResponse(event),
        };
      });
    },
  };
}
