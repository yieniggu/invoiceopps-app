import { Link } from "react-router";

import { DataTable, type DataColumn } from "../../../components/DataTable";
import { paths } from "../../navigation/paths";
import {
  invoiceCivilDate,
  invoiceLabel,
  invoiceMoney,
  isOverdue,
  todayCivilDate,
} from "../invoicePresentation";
import type { Invoice } from "../types";
import { InvoiceStatusBadge } from "./InvoiceStatusBadge";

/** Name of the invoice's group, or «Sin grupo» for the organization scope. */
export function groupLabel(invoice: Invoice) {
  if (invoice.groupId === null) return "Sin grupo";
  // The API always names a group it returns; the generic label is a guard.
  return invoice.groupName ?? invoiceLabel(null);
}

/**
 * Rows of the inbox. The business status is the only status shown; the
 * processing status belongs to the detail, labelled apart. The number is the
 * row's link and stretches over the whole row.
 */
export function InvoiceTable({
  invoices,
  inboxSearch,
  today = todayCivilDate(),
  busy = false,
}: {
  invoices: readonly Invoice[];
  /** Inbox URL state, handed to the detail so its back link restores it. */
  inboxSearch: string;
  /** Civil date overdue invoices are measured against. */
  today?: string;
  /** The page on screen is the previous one while the next loads. */
  busy?: boolean;
}) {
  const columns: DataColumn<Invoice>[] = [
    {
      header: "Número",
      className: "col-number",
      cell: (invoice) => (
        <Link
          to={paths.invoice(invoice.id, invoice)}
          state={{ inboxSearch }}
          className="row-link"
        >
          {invoice.businessId}
        </Link>
      ),
    },
    { header: "Proveedor", cell: ({ supplierName }) => supplierName },
    {
      header: "Grupo",
      cell: (invoice) => (
        <span className="group-pill">{groupLabel(invoice)}</span>
      ),
    },
    { header: "Emisión", cell: ({ issuedOn }) => invoiceCivilDate(issuedOn) },
    {
      header: "Vencimiento",
      cell: (invoice) =>
        isOverdue(invoice, today) ? (
          <span className="due-overdue">
            {invoiceCivilDate(invoice.dueOn)}
            <span className="overdue-label">Vencida</span>
          </span>
        ) : (
          invoiceCivilDate(invoice.dueOn)
        ),
    },
    {
      header: "Estado",
      className: "col-status",
      cell: ({ businessStatus }) => (
        <InvoiceStatusBadge status={businessStatus} />
      ),
    },
    {
      header: "Monto",
      className: "col-amount",
      cell: ({ amountPesos }) => invoiceMoney(amountPesos),
    },
  ];
  return (
    <DataTable
      label="Facturas"
      rows={invoices}
      columns={columns}
      className="invoice-table"
      busy={busy}
    />
  );
}

/** Placeholder rows while the first page loads (the screen announces it). */
export function InvoiceTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="invoice-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="skeleton-block invoice-skeleton-row" />
      ))}
    </div>
  );
}
