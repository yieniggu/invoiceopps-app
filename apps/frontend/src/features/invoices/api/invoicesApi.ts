import { withQuery } from "../../../lib/pagination";
import { apiRequest } from "../../auth/api/apiRequest";
import type {
  Invoice,
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
) =>
  apiRequest<{ invoice: Invoice }>(
    withQuery(`${base}/${encodeURIComponent(invoiceId)}`, {
      organizationId,
      groupId,
    }),
    { signal },
  ).then((result) => result.invoice);

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
