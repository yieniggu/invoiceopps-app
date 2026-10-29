import type { Operation } from "../../http/registry.js";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  retryableConflictResponse,
  unauthenticatedResponse,
  validationResponse,
} from "../../http/standard-responses.js";
import type { AuthService } from "../auth/services.js";
import { createInvoiceController } from "./controllers.js";
import {
  IdempotencyKeyHeaderSchema,
  InvoiceCreateRequestSchema,
  InvoiceResponseSchema,
} from "./schemas.js";
import type { InvoiceCreateService } from "./services.js";

const TAG = "Invoices";

export function createInvoiceOperations(
  auth: AuthService | undefined,
  invoices: InvoiceCreateService | undefined,
): Operation[] {
  const controller = createInvoiceController(auth, invoices);

  return [
    {
      method: "post",
      path: "/invoices",
      summary:
        "Create an invoice in an organization or in one of its groups, idempotently",
      tag: TAG,
      secured: true,
      headers: IdempotencyKeyHeaderSchema,
      requestBody: InvoiceCreateRequestSchema,
      responses: {
        201: {
          description:
            "Invoice created (processingStatus NOT_REQUESTED), or the stored response of an earlier identical request with the same Idempotency-Key (Idempotency-Replayed: true)",
          schema: InvoiceResponseSchema,
          headers: {
            Location: {
              description:
                "Context-bearing URL of the invoice: /api/v1/invoices/{id}?organizationId=...[&groupId=...]",
            },
            "Idempotency-Replayed": {
              description: "true only when the response is a replay",
            },
          },
        },
        400: validationResponse(
          "missing or malformed Idempotency-Key (16 to 128 of A-Z a-z 0-9 _ -), or an invalid or unknown body field; nothing is persisted",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "the actor lacks createInvoices in this scope (organization flags, or organization OR group flags in a group), or the organization is disabled; checked before any stored response is read",
        ),
        404: notFoundResponse(
          "the organization does not exist, the actor is not a member (the platform administrator has no implicit membership), or the group does not belong to the organization",
        ),
        409: errorResponse(
          "IDEMPOTENCY_CONFLICT: the key was already used in this scope with a different body; BUSINESS_ID_CONFLICT: the businessId already exists in the organization (soft-deleted invoices keep theirs reserved)",
        ),
        410: errorResponse(
          "INVOICE_DELETED: the invoice created with this key was deleted; it is not restored or recreated",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.create,
    },
  ];
}
