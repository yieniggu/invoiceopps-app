import { withQuery } from "../../../lib/pagination";
import { apiRequest } from "../../auth/api/apiRequest";
import type {
  CreatedInvoice,
  Invoice,
  InvoiceCreateInput,
  InvoiceDetail,
  InvoicePrediction,
  InvoiceScope,
  InvoiceListRequest,
  InvoicePage,
} from "../types";

const base = "/api/v1/invoices";

export const listInvoices = (
  scope: InvoiceScope,
  request: InvoiceListRequest,
  signal?: AbortSignal,
) =>
  apiRequest<InvoicePage>(
    withQuery(base, {
      organizationId: scope.organizationId,
      groupId: scope.kind === "group" ? scope.groupId : undefined,
      ...request,
      q: request.q || undefined,
    }),
    { signal },
  );

export const getInvoice = (
  invoiceId: string,
  organizationId: string,
  groupId: string | undefined,
  signal?: AbortSignal,
): Promise<InvoiceDetail> =>
  apiRequest<{ invoice: Invoice; predictions?: InvoicePrediction[] }>(
    withQuery(`${base}/${encodeURIComponent(invoiceId)}`, {
      organizationId,
      groupId,
    }),
    { signal },
  ).then((result) =>
    result.predictions
      ? { ...result.invoice, predictions: result.predictions }
      : result.invoice,
  );

/** Logical delete; the API answers 204 and is idempotent for its own result. */
export const deleteInvoice = (
  invoiceId: string,
  organizationId: string,
  groupId: string | undefined,
) =>
  apiRequest<void>(
    withQuery(`${base}/${encodeURIComponent(invoiceId)}`, {
      organizationId,
      groupId,
    }),
    { method: "DELETE" },
  );

/**
 * Creates an invoice. The key identifies one logical attempt: replaying it
 * with the same body answers the same invoice, so a retry never duplicates.
 */
export const createInvoice = (
  input: InvoiceCreateInput,
  idempotencyKey: string,
  signal?: AbortSignal,
) =>
  apiRequest<{ invoice: CreatedInvoice }>(base, {
    method: "POST",
    body: input,
    headers: { "Idempotency-Key": idempotencyKey },
    signal,
  }).then((result) => result.invoice);
