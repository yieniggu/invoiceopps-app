import type { Operation } from "../../http/registry.js";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  retryableConflictResponse,
  retryableReadConflictResponse,
  unauthenticatedResponse,
  validationResponse,
} from "../../http/standard-responses.js";
import type { AuthService } from "../auth/services.js";
import { createInvoiceController } from "./controllers.js";
import {
  IdempotencyKeyHeaderSchema,
  InvoiceCreateRequestSchema,
  InvoiceTargetQuerySchema,
  InvoiceListQuerySchema,
  InvoicePageSchema,
  InvoiceParamsSchema,
  InvoiceResponseSchema,
  InvoiceViewResponseSchema,
} from "./schemas.js";
import type {
  InvoiceCreateService,
  InvoiceDeleteService,
  InvoiceReadService,
} from "./services.js";

const TAG = "Invoices";

export function createInvoiceOperations(
  auth: AuthService | undefined,
  invoices: InvoiceCreateService | undefined,
  reads: InvoiceReadService | undefined,
  deletion: InvoiceDeleteService | undefined,
): Operation[] {
  const controller = createInvoiceController(auth, invoices, reads, deletion);

  return [
    {
      method: "get",
      path: "/invoices",
      summary:
        "List the invoices of an organization, of one group or of no group, newest first",
      tag: TAG,
      secured: true,
      query: InvoiceListQuerySchema,
      responses: {
        200: {
          description:
            "One page of invoices, each with groupName (null in the organization scope); total counts every invoice matching the same filters",
          schema: InvoicePageSchema,
        },
        400: validationResponse(
          "unknown or repeated query parameter, malformed organizationId or groupId, groupId together with ungrouped=true, unknown businessStatus, impossible or inverted issued dates, q over 120 characters, page outside 1..10000 or pageSize outside 1..100",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "the actor lacks readInvoices in this scope (organization flags for the whole organization or ungrouped invoices; organization OR group flags in a group), or the organization is disabled",
        ),
        404: notFoundResponse(
          "the organization does not exist or the actor is not a member, the group does not belong to the organization, or the actor lacks organization read and is not a member of the group",
        ),
        503: retryableReadConflictResponse,
      },
      handler: controller.list,
    },
    {
      method: "get",
      path: "/invoices/{invoiceId}",
      summary: "Get one invoice by id within its organization context",
      tag: TAG,
      secured: true,
      params: InvoiceParamsSchema,
      query: InvoiceTargetQuerySchema,
      responses: {
        200: {
          description:
            "The invoice with groupName (null in the organization scope). groupId is optional context: when given it must be the group of the invoice",
          schema: InvoiceViewResponseSchema,
        },
        400: validationResponse(
          "missing or malformed organizationId, malformed groupId, or an unknown query parameter",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "the actor lacks readInvoices in the invoice scope, or the organization is disabled",
        ),
        404: notFoundResponse(
          "the organization does not exist or the actor is not a member, the invoiceId is not a uuid, the invoice does not exist, is deleted or belongs to another organization, groupId does not match the invoice, or the actor cannot see the group; all answer the same body",
        ),
        503: retryableReadConflictResponse,
      },
      handler: controller.get,
    },
    {
      method: "delete",
      path: "/invoices/{invoiceId}",
      summary:
        "Logically delete an invoice by id within its organization context, idempotently",
      tag: TAG,
      secured: true,
      params: InvoiceParamsSchema,
      query: InvoiceTargetQuerySchema,
      responses: {
        204: {
          description:
            "Invoice deleted (deletedAt and deletedByUserId set, one INVOICE_DELETED event recorded), or already deleted by an earlier request: repeating an authorized request changes nothing. The invoice, its creator, idempotency records and businessId are kept; the businessId stays reserved",
        },
        400: validationResponse(
          "missing or malformed organizationId, malformed groupId, or an unknown query parameter",
        ),
        401: unauthenticatedResponse,
        403: forbiddenResponse(
          "the invoice is in the actor's scope but the actor lacks the applicable delete flag: deleteOwnInvoices for an invoice the actor created, deleteOthersInvoices otherwise (organization flags for an organization invoice; organization OR group flags for a group invoice); readInvoices and createInvoices are not required; or the organization is disabled",
        ),
        404: notFoundResponse(
          "the organization does not exist or the actor is not a member (the platform administrator has no implicit membership), the invoiceId is not a uuid, the invoice does not exist or belongs to another organization, groupId does not match the invoice, or the invoice belongs to a group the actor is not in and the organization flags grant neither readInvoices nor the applicable delete flag; all answer the same body",
        ),
        503: retryableConflictResponse,
      },
      handler: controller.remove,
    },
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
