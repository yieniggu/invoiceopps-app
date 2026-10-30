import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { ApiError } from "../../http/errors.js";
import { logEvent } from "../../http/logging.js";
import { escapeLike, pageWindow } from "../../pagination.js";
import {
  isUniqueViolation,
  retryableConflict,
  runSerializable,
  SERIALIZABLE,
} from "../../transactions.js";
import {
  canDeleteInvoice,
  loadEffectivePermissions,
  loadScopePermissions,
  type InvoicePermissions,
} from "../groups/invoice-permissions.js";
import { lockMembershipsForInvoiceWrite } from "../groups/locks.js";
import {
  fingerprintInvoiceCreate,
  INVOICE_CREATE_FINGERPRINT_VERSION,
  INVOICE_CREATE_OPERATION,
  isSupportedFingerprintVersion,
} from "./idempotency.js";
import { InvoiceSchema } from "./schemas.js";
import type {
  Invoice,
  InvoiceCreateRequest,
  InvoiceListQuery,
  InvoicePage,
  InvoiceView,
} from "./types.js";

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

export interface InvoiceReadService {
  listInvoices(userId: string, query: InvoiceListQuery): Promise<InvoicePage>;
  getInvoice(
    userId: string,
    target: { invoiceId: string; organizationId: string; groupId?: string },
  ): Promise<{ invoice: InvoiceView }>;
}

export interface InvoiceDeleteService {
  /**
   * Logical deletion. `deleted` is true only when this call deleted the
   * invoice; an authorized repeat resolves with `deleted: false` and writes
   * nothing (no second event). `groupId` is the invoice's real group (null
   * for an organization invoice), whatever context the caller named.
   */
  deleteInvoice(
    userId: string,
    target: { invoiceId: string; organizationId: string; groupId?: string },
  ): Promise<{ deleted: boolean; groupId: string | null }>;
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

/** Read DTO: the explicit Invoice plus the name of the group, if any. */
function toInvoiceViewDto(
  row: Parameters<typeof toInvoiceDto>[0] & {
    group: { name: string } | null;
  },
): InvoiceView {
  return { ...toInvoiceDto(row), groupName: row.group?.name ?? null };
}

/** Group name joined in the same query as the invoice rows. */
const WITH_GROUP_NAME = {
  group: { select: { name: true } },
} satisfies Prisma.InvoiceInclude;

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

/** One snapshot for membership checks, rows and count of a read. */
const SNAPSHOT = { isolationLevel: "RepeatableRead" } as const;

function forbidden() {
  return new ApiError(403, "FORBIDDEN", "Reading invoices is not allowed");
}

/** The where of the list, built from the validated query only. */
function listWhere(query: InvoiceListQuery): Prisma.InvoiceWhereInput {
  const { groupId, ungrouped, q } = query;
  return {
    organizationId: query.organizationId,
    deletedAt: null,
    ...(groupId !== undefined
      ? { scopeKey: groupId }
      : ungrouped
        ? { scopeKey: ORGANIZATION_SCOPE_KEY }
        : {}),
    ...(query.businessStatus ? { businessStatus: query.businessStatus } : {}),
    ...(query.issuedFrom || query.issuedTo
      ? {
          issuedOn: {
            ...(query.issuedFrom ? { gte: toCivilDate(query.issuedFrom) } : {}),
            ...(query.issuedTo ? { lte: toCivilDate(query.issuedTo) } : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            {
              businessId: { contains: escapeLike(q), mode: "insensitive" },
            },
            {
              supplierName: { contains: escapeLike(q), mode: "insensitive" },
            },
          ],
        }
      : {}),
  };
}

export function createInvoiceReadService(
  prisma: PrismaClient,
): InvoiceReadService {
  /**
   * One RepeatableRead snapshot per read. It runs under runSerializable so a
   * transaction timeout (P2028) or a lost snapshot race answers the same
   * retryable 503 as the writes instead of a 500.
   */
  function readSnapshot<T>(
    operation: string,
    work: (transaction: Prisma.TransactionClient) => Promise<T>,
  ) {
    return runSerializable(
      () => prisma.$transaction(work, SNAPSHOT),
      undefined,
      operation,
    );
  }

  /** Nonexistent organization and non-member are indistinguishable. */
  async function requireOrganizationMember(
    transaction: Prisma.TransactionClient,
    userId: string,
    organizationId: string,
  ) {
    const membership = await transaction.organizationMembership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { userId: true },
    });
    if (!membership) throw notFound();
  }

  /**
   * Group scope: organization read sees every group of the organization;
   * otherwise only a member of the group, and then its effective read decides.
   * The caller already proved the group exists in the organization. The
   * organization-level and the effective flags come from one load.
   */
  async function requireGroupRead(
    transaction: Prisma.TransactionClient,
    userId: string,
    organizationId: string,
    groupId: string,
  ) {
    const { organization, effective } = await loadScopePermissions(
      transaction,
      { userId, organizationId, groupId },
    );
    if (organization.readInvoices) return;
    const member = await transaction.groupMembership.findFirst({
      where: { userId, organizationId, groupId },
      select: { userId: true },
    });
    if (!member) throw notFound();
    if (!effective.readInvoices) throw forbidden();
  }

  return {
    async listInvoices(userId, query) {
      const { organizationId, groupId } = query;
      return readSnapshot("invoice_list", async (transaction) => {
        await requireOrganizationMember(transaction, userId, organizationId);
        if (groupId !== undefined) {
          const group = await transaction.group.findFirst({
            where: { id: groupId, organizationId },
            select: { id: true },
          });
          if (!group) throw notFound();
          await requireGroupRead(transaction, userId, organizationId, groupId);
        } else {
          const permissions = await loadEffectivePermissions(transaction, {
            userId,
            organizationId,
            groupId: null,
          });
          if (!permissions.readInvoices) throw forbidden();
        }
        const where = listWhere(query);
        // Sequential: the transaction owns one connection and both reads see
        // the same snapshot.
        const rows = await transaction.invoice.findMany({
          where,
          include: WITH_GROUP_NAME,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          ...pageWindow(query),
        });
        const total = await transaction.invoice.count({ where });
        return {
          items: rows.map(toInvoiceViewDto),
          page: query.page,
          pageSize: query.pageSize,
          total,
        };
      });
    },

    async getInvoice(userId, { invoiceId, organizationId, groupId }) {
      return readSnapshot("invoice_get", async (transaction) => {
        await requireOrganizationMember(transaction, userId, organizationId);
        const row = await transaction.invoice.findFirst({
          where: { id: invoiceId, organizationId, deletedAt: null },
          include: WITH_GROUP_NAME,
        });
        if (!row) throw notFound();
        // The context in the URL must match the invoice's real scope.
        if (groupId !== undefined && groupId !== row.groupId) throw notFound();
        if (row.groupId === null) {
          const permissions = await loadEffectivePermissions(transaction, {
            userId,
            organizationId,
            groupId: null,
          });
          if (!permissions.readInvoices) throw forbidden();
        } else {
          await requireGroupRead(
            transaction,
            userId,
            organizationId,
            row.groupId,
          );
        }
        return { invoice: toInvoiceViewDto(row) };
      });
    },
  };
}

export type InvoiceDeletionDecision = "allowed" | "forbidden" | "not-found";

/**
 * Pure outcome of a deletion for an actor that belongs to the organization.
 * An organization invoice is in scope for every member. A group invoice is in
 * scope for a member of the group; any other member sees it only when the
 * organization-level flags grant readInvoices or the applicable delete flag,
 * otherwise it answers like a missing invoice. Inside the scope the
 * applicable delete flag (own or others) of the effective permissions decides;
 * read and create are never required.
 *
 * Contract note (CR-337): inside the organization scope the answer differs on
 * purpose (403 for a visible invoice the actor may not delete, 404 for one
 * outside the actor's scope). This is the approved AC-06 / AC-09 contract, not
 * an enumeration leak to be closed: an organization member may already see the
 * organization's invoices.
 */
export function decideInvoiceDeletion(input: {
  groupId: string | null;
  organizationPermissions: InvoicePermissions;
  effectivePermissions: InvoicePermissions;
  isGroupMember: boolean;
  creatorUserId: string;
  actorUserId: string;
}): InvoiceDeletionDecision {
  const { creatorUserId, actorUserId } = input;
  if (input.groupId !== null && !input.isGroupMember) {
    const visible =
      input.organizationPermissions.readInvoices ||
      canDeleteInvoice(
        input.organizationPermissions,
        creatorUserId,
        actorUserId,
      );
    if (!visible) return "not-found";
  }
  return canDeleteInvoice(
    input.effectivePermissions,
    creatorUserId,
    actorUserId,
  )
    ? "allowed"
    : "forbidden";
}

export function createInvoiceDeleteService(
  prisma: PrismaClient,
): InvoiceDeleteService {
  /**
   * One serializable attempt. The invoice is read by its real (id,
   * organizationId), deleted ones included; the memberships are then locked
   * FOR SHARE in the global order of lockMembershipsForInvoiceWrite, so a
   * permission change or removal serializes with the deletion. The group
   * used for the permissions is always the one of the invoice, never the one
   * of the query.
   */
  async function attempt(
    transaction: Prisma.TransactionClient,
    actorUserId: string,
    target: { invoiceId: string; organizationId: string; groupId?: string },
  ) {
    const { invoiceId, organizationId } = target;
    // Read before the lock on purpose: the lock rows depend on the invoice's
    // group. This is safe because an invoice's organizationId, groupId and
    // scopeKey are immutable (the database trigger Invoice_scope_immutable
    // rejects any change), so the group read here is still the group of the
    // invoice once the memberships are locked.
    const invoice = await transaction.invoice.findFirst({
      where: { id: invoiceId, organizationId },
      select: { groupId: true, createdByUserId: true, deletedAt: true },
    });
    if (!invoice) throw notFound();
    if (target.groupId !== undefined && target.groupId !== invoice.groupId) {
      throw notFound();
    }
    const { organizationMembership, groupMembership } =
      await lockMembershipsForInvoiceWrite(transaction, {
        userId: actorUserId,
        organizationId,
        groupId: invoice.groupId,
      });
    // The platform administrator has no implicit membership.
    if (!organizationMembership) throw notFound();
    const {
      organization: organizationPermissions,
      effective: effectivePermissions,
    } = await loadScopePermissions(transaction, {
      userId: actorUserId,
      organizationId,
      groupId: invoice.groupId,
    });
    const decision = decideInvoiceDeletion({
      groupId: invoice.groupId,
      organizationPermissions,
      effectivePermissions,
      isGroupMember: groupMembership !== null,
      creatorUserId: invoice.createdByUserId,
      actorUserId,
    });
    if (decision === "not-found") throw notFound();
    if (decision === "forbidden") {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Deleting this invoice is not allowed",
      );
    }
    // Authorized repeat: nothing changes and no second event is written.
    if (invoice.deletedAt) return { deleted: false, groupId: invoice.groupId };

    // One instant for the tombstone and its event.
    const now = new Date();
    const { count } = await transaction.invoice.updateMany({
      where: { id: invoiceId, organizationId, deletedAt: null },
      data: { deletedAt: now, deletedByUserId: actorUserId },
    });
    if (count !== 1) return { deleted: false, groupId: invoice.groupId };
    await transaction.invoiceEvent.create({
      data: {
        invoiceId,
        type: "INVOICE_DELETED",
        actorUserId,
        organizationId,
        groupId: invoice.groupId,
        createdAt: now,
      },
    });
    return { deleted: true, groupId: invoice.groupId };
  }

  return {
    async deleteInvoice(actorUserId, target) {
      // Serialization failures, deadlocks and transaction timeouts are
      // handled by runSerializable (bounded retries, then the retryable 503).
      // The event insert is guarded by the updateMany count, so a unique
      // violation cannot normally surface; if one does, it is a lost race
      // and answers the same retryable 503 instead of a 500.
      try {
        return await runSerializable(
          () =>
            prisma.$transaction(
              (transaction) => attempt(transaction, actorUserId, target),
              SERIALIZABLE,
            ),
          undefined,
          "invoice_delete",
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        logEvent("warn", "transaction.conflict", {
          operation: "invoice_delete",
          attempt: 1,
          outcome: "gave_up",
          reason: "conflict",
        });
        throw retryableConflict();
      }
    },
  };
}
