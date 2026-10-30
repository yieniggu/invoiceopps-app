import type { RequestHandler } from "express";

import { ApiError, parseWith } from "../../http/errors.js";
import { logEvent } from "../../http/logging.js";
import type { AuthService } from "../auth/services.js";
import { requireSessionProfile } from "../auth/session.js";
import {
  IdempotencyKeyHeaderSchema,
  InvoiceCreateRequestSchema,
  InvoiceTargetQuerySchema,
  InvoiceListQuerySchema,
  InvoiceParamsSchema,
} from "./schemas.js";
import {
  invoiceLocation,
  type InvoiceCreateService,
  type InvoiceDeleteService,
  type InvoiceReadService,
} from "./services.js";

/** A route whose backing service is not wired answers like a missing session. */
function wired<Service>(service: Service | undefined) {
  if (!service) throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
  return service;
}

/**
 * The invoiceId path parameter is validated like any other boundary input. A
 * malformed id (not a uuid, a NUL byte) answers the same generic 404 as a
 * missing invoice, so the response never tells the two apart and the value
 * never reaches the database.
 */
function parseInvoiceId(params: unknown) {
  const parsed = InvoiceParamsSchema.safeParse(params);
  if (!parsed.success) throw new ApiError(404, "NOT_FOUND", "Not found");
  return parsed.data.invoiceId;
}

export function createInvoiceController(
  auth: AuthService | undefined,
  invoices: InvoiceCreateService | undefined,
  reads: InvoiceReadService | undefined,
  deletion: InvoiceDeleteService | undefined,
) {
  const create: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    // Both validations run before any database access.
    const { "Idempotency-Key": idempotencyKey } = parseWith(
      IdempotencyKeyHeaderSchema,
      { "Idempotency-Key": request.headers["idempotency-key"] },
      "Invalid Idempotency-Key header",
    );
    const input = parseWith(
      InvoiceCreateRequestSchema,
      request.body,
      "Invalid invoice",
    );
    const service = wired(invoices);
    let result;
    try {
      result = await service.createInvoice(actor.id, input, idempotencyKey);
    } catch (error) {
      // Conflicts and the 410 are expected outcomes, recorded with the code
      // only. A 503 is logged where it is decided (transaction.conflict), a
      // corrupt replay by replayedInvoice and unexpected failures by the
      // error handler.
      if (
        error instanceof ApiError &&
        (error.status === 409 || error.status === 410)
      ) {
        logEvent("info", "invoice.create_rejected", {
          feature: "invoices",
          code: error.code,
          organizationId: input.organizationId,
          ...(input.groupId ? { groupId: input.groupId } : {}),
        });
      }
      throw error;
    }
    const { invoice, replayed } = result;
    // Opaque ids only: never the body, businessId, amounts or the key.
    logEvent("info", replayed ? "invoice.replayed" : "invoice.created", {
      feature: "invoices",
      organizationId: invoice.organizationId,
      ...(invoice.groupId ? { groupId: invoice.groupId } : {}),
      invoiceId: invoice.id,
    });
    response.set("Location", invoiceLocation(invoice));
    if (replayed) response.set("Idempotency-Replayed", "true");
    response.status(201).json({ invoice });
  };

  const list: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const query = parseWith(
      InvoiceListQuerySchema,
      request.query,
      "Invalid invoice query",
    );
    response.status(200).json(await wired(reads).listInvoices(actor.id, query));
  };

  const get: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const { organizationId, groupId } = parseWith(
      InvoiceTargetQuerySchema,
      request.query,
      "Invalid invoice query",
    );
    const invoiceId = parseInvoiceId(request.params);
    response.status(200).json(
      await wired(reads).getInvoice(actor.id, {
        invoiceId,
        organizationId,
        ...(groupId ? { groupId } : {}),
      }),
    );
  };

  const remove: RequestHandler = async (request, response) => {
    const actor = await requireSessionProfile(auth, request, response);
    const { organizationId, groupId } = parseWith(
      InvoiceTargetQuerySchema,
      request.query,
      "Invalid invoice query",
    );
    let result;
    let invoiceId: string;
    try {
      // Inside the try so a malformed id is recorded like any other 404.
      invoiceId = parseInvoiceId(request.params);
      result = await wired(deletion).deleteInvoice(actor.id, {
        invoiceId,
        organizationId,
        ...(groupId ? { groupId } : {}),
      });
    } catch (error) {
      // Denials are expected outcomes, recorded with the status only. A 503
      // is logged where it is decided (transaction.conflict).
      if (
        error instanceof ApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        logEvent("info", "invoice.delete_rejected", {
          feature: "invoices",
          status: error.status,
          code: error.code,
          organizationId,
          actorUserId: actor.id,
        });
      }
      throw error;
    }
    // Only the call that deleted the invoice logs it. An authorized repeat is
    // a no-op that writes no event and therefore logs nothing. The groupId is
    // the invoice's real group, not the optional one of the query. Opaque ids
    // only: never business data.
    if (result.deleted) {
      logEvent("info", "invoice.deleted", {
        feature: "invoices",
        organizationId,
        ...(result.groupId ? { groupId: result.groupId } : {}),
        invoiceId,
        actorUserId: actor.id,
      });
    }
    response.status(204).end();
  };

  return { create, list, get, remove };
}
