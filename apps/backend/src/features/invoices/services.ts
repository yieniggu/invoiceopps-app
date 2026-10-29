import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import { logEvent } from "../../http/logging.js";
import {
  isUniqueViolation,
  retryableConflict,
  runSerializable,
  SERIALIZABLE,
} from "../../transactions.js";
import { loadEffectivePermissions } from "../groups/invoice-permissions.js";
import { lockMembershipsForInvoiceWrite } from "../groups/locks.js";
import {
  fingerprintInvoiceCreate,
  INVOICE_CREATE_FINGERPRINT_VERSION,
  INVOICE_CREATE_OPERATION,
  isSupportedFingerprintVersion,
} from "./idempotency.js";
import { InvoiceSchema } from "./schemas.js";
import type { Invoice, InvoiceCreateRequest } from "./types.js";

/** scopeKey of an invoice outside any group (mirrors the database CHECK). */
const ORGANIZATION_SCOPE_KEY = "organization";

/** Attempts after a unique violation before answering a retryable 503. */
const MAX_UNIQUE_RACE_ATTEMPTS = 3;

export interface InvoiceCreateResult {
  invoice: Invoice;
  /** True when the stored response of an earlier identical request is served. */
  replayed: boolean;
}

export interface InvoiceCreateService {
  createInvoice(
    actorUserId: string,
    request: InvoiceCreateRequest,
    idempotencyKey: string,
  ): Promise<InvoiceCreateResult>;
}

/** Civil dates travel as YYYY-MM-DD and are stored as UTC midnight (DATE). */
function toCivilDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function fromCivilDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

/** Explicit DTO: a database row is never spread into a response. */
function toInvoiceDto(row: {
  id: string;
  organizationId: string;
  groupId: string | null;
  businessId: string;
  supplierName: string;
  amountPesos: number;
  currency: "CLP";
  issuedOn: Date;
  dueOn: Date;
  businessStatus: Invoice["businessStatus"];
  processingStatus: "NOT_REQUESTED";
  createdByUserId: string;
  createdAt: Date;
}): Invoice {
  return {
    id: row.id,
    organizationId: row.organizationId,
    groupId: row.groupId,
    businessId: row.businessId,
    supplierName: row.supplierName,
    amountPesos: row.amountPesos,
    currency: row.currency,
    issuedOn: fromCivilDate(row.issuedOn),
    dueOn: fromCivilDate(row.dueOn),
    businessStatus: row.businessStatus,
    processingStatus: row.processingStatus,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Context-bearing URL of an invoice, also the Location of its creation. */
export function invoiceLocation(invoice: Invoice) {
  const query = new URLSearchParams({ organizationId: invoice.organizationId });
  if (invoice.groupId) query.set("groupId", invoice.groupId);
  return `/api/v1/invoices/${invoice.id}?${query.toString()}`;
}

/**
 * Validates a stored response snapshot before it is served again. A snapshot
 * that no longer matches the Invoice contract is a server-side defect: it is
 * logged without its contents and answered as a controlled 500.
 */
export function replayedInvoice(snapshot: unknown): Invoice {
  const parsed = InvoiceSchema.safeParse(snapshot);
  if (!parsed.success) {
    logEvent("error", "invoice.replay_snapshot_invalid", {
      feature: "invoices",
      code: "INTERNAL_ERROR",
    });
    throw new ApiError(500, "INTERNAL_ERROR", "Internal server error");
  }
  return parsed.data;
}

/**
 * Whether a stored record belongs to this request. The stored version decides
 * how the request is re-fingerprinted, so a future version bump never turns
 * old records into false conflicts. A version this build cannot recompute
 * cannot prove equality and therefore conflicts.
 */
export function matchesStoredFingerprint(
  request: InvoiceCreateRequest,
  stored: { fingerprint: string; fingerprintVersion: number },
) {
  if (!isSupportedFingerprintVersion(stored.fingerprintVersion)) return false;
  return (
    fingerprintInvoiceCreate(request, stored.fingerprintVersion) ===
    stored.fingerprint
  );
}

function notFound() {
  return new ApiError(404, "NOT_FOUND", "Not found");
}

export function createInvoiceCreateService(
  prisma: PrismaClient,
): InvoiceCreateService {
  /**
   * One serializable attempt. Authorization comes first (rows locked FOR
   * SHARE, so a concurrent permission change or removal serializes with it)
   * and the idempotency record is read only afterwards: a revoked actor never
   * sees a stored snapshot.
   *
   * The businessId is not pre-read on the first attempt: a read inside the
   * SERIALIZABLE transaction adds predicate locks that could abort unrelated
   * parallel creates. The unique (organizationId, businessId) index decides;
   * only the attempt after a unique violation looks the businessId up.
   */
  async function attempt(
    transaction: Prisma.TransactionClient,
    actorUserId: string,
    request: InvoiceCreateRequest,
    idempotencyKey: string,
    afterUniqueViolation: boolean,
  ): Promise<InvoiceCreateResult> {
    const { organizationId, groupId } = request;
    const { organizationMembership } = await lockMembershipsForInvoiceWrite(
      transaction,
      { userId: actorUserId, organizationId, groupId },
    );
    // Nonexistent organization and non-member are indistinguishable; the
    // platform administrator has no implicit membership.
    if (!organizationMembership) throw notFound();
    if (groupId !== null) {
      const group = await transaction.group.findFirst({
        where: { id: groupId, organizationId },
        select: { id: true },
      });
      if (!group) throw notFound();
    }
    const permissions = await loadEffectivePermissions(transaction, {
      userId: actorUserId,
      organizationId,
      groupId,
    });
    if (!permissions.createInvoices) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Creating invoices in this scope is not allowed",
      );
    }

    const scopeKey = groupId ?? ORGANIZATION_SCOPE_KEY;
    const fingerprint = fingerprintInvoiceCreate(request);
    const record = await transaction.invoiceIdempotencyRecord.findUnique({
      where: {
        userId_organizationId_scopeKey_operation_key: {
          userId: actorUserId,
          organizationId,
          scopeKey,
          operation: INVOICE_CREATE_OPERATION,
          key: idempotencyKey,
        },
      },
      select: {
        fingerprint: true,
        fingerprintVersion: true,
        responseSnapshot: true,
        invoice: { select: { deletedAt: true } },
      },
    });
    if (record) {
      if (!matchesStoredFingerprint(request, record)) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "The Idempotency-Key was already used with a different request",
        );
      }
      if (record.invoice.deletedAt) {
        throw new ApiError(
          410,
          "INVOICE_DELETED",
          "The invoice created by this request was deleted",
        );
      }
      return {
        invoice: replayedInvoice(record.responseSnapshot),
        replayed: true,
      };
    }

    if (afterUniqueViolation) {
      // Soft-deleted invoices keep their businessId reserved.
      const taken = await transaction.invoice.findUnique({
        where: {
          organizationId_businessId: {
            organizationId,
            businessId: request.businessId,
          },
        },
        select: { id: true },
      });
      if (taken) {
        throw new ApiError(
          409,
          "BUSINESS_ID_CONFLICT",
          "The businessId already exists in this organization",
        );
      }
    }

    const row = await transaction.invoice.create({
      data: {
        organizationId,
        groupId,
        scopeKey,
        businessId: request.businessId,
        supplierName: request.supplierName,
        amountPesos: request.amountPesos,
        currency: request.currency,
        issuedOn: toCivilDate(request.issuedOn),
        dueOn: toCivilDate(request.dueOn),
        businessStatus: request.businessStatus,
        createdByUserId: actorUserId,
      },
    });
    const invoice = toInvoiceDto(row);
    await transaction.invoiceIdempotencyRecord.create({
      data: {
        userId: actorUserId,
        organizationId,
        groupId,
        scopeKey,
        operation: INVOICE_CREATE_OPERATION,
        key: idempotencyKey,
        fingerprint,
        fingerprintVersion: INVOICE_CREATE_FINGERPRINT_VERSION,
        invoiceId: invoice.id,
        responseSnapshot: invoice as unknown as Prisma.InputJsonObject,
      },
    });
    return { invoice, replayed: false };
  }

  return {
    async createInvoice(actorUserId, request, idempotencyKey) {
      // A unique violation aborts its PostgreSQL transaction, so it is never
      // continued: the next attempt is a new transaction that re-authorizes
      // and re-reads, finding either the winner's record (replay) or the
      // taken businessId (BUSINESS_ID_CONFLICT; looked up only from the second
      // attempt on).
      for (let race = 0; race < MAX_UNIQUE_RACE_ATTEMPTS; race += 1) {
        try {
          return await runSerializable(
            () =>
              prisma.$transaction(
                (transaction) =>
                  attempt(
                    transaction,
                    actorUserId,
                    request,
                    idempotencyKey,
                    race > 0,
                  ),
                SERIALIZABLE,
              ),
            undefined,
            "invoice_create",
          );
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      // runSerializable only logs serialization conflicts; an exhausted run of
      // unique violations is recorded here with the same event.
      logEvent("warn", "transaction.conflict", {
        operation: "invoice_create",
        attempt: MAX_UNIQUE_RACE_ATTEMPTS,
        outcome: "gave_up",
      });
      throw retryableConflict();
    },
  };
}
