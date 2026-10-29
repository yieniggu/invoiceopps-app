import type { RequestHandler } from "express";

import { ApiError, parseWith } from "../../http/errors.js";
import { logEvent } from "../../http/logging.js";
import type { AuthService } from "../auth/services.js";
import { requireSessionProfile } from "../auth/session.js";
import {
  IdempotencyKeyHeaderSchema,
  InvoiceCreateRequestSchema,
} from "./schemas.js";
import { invoiceLocation, type InvoiceCreateService } from "./services.js";

/** A route whose backing service is not wired answers like a missing session. */
function wired(service: InvoiceCreateService | undefined) {
  if (!service) throw new ApiError(401, "UNAUTHENTICATED", "Unauthenticated");
  return service;
}

export function createInvoiceController(
  auth: AuthService | undefined,
  invoices: InvoiceCreateService | undefined,
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

  return { create };
}
