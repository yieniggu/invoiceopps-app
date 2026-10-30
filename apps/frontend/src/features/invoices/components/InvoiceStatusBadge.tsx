import { invoiceLabel } from "../invoicePresentation";

const TONES: Record<string, string> = {
  PENDING: "is-pending",
  APPROVED: "is-approved",
  REJECTED: "is-rejected",
};

/** Business status as a colored pill; the text always says it too. */
export function InvoiceStatusBadge({ status }: { status: string }) {
  return (
    <span className={`status-badge ${TONES[status] ?? "is-neutral"}`}>
      {invoiceLabel(status)}
    </span>
  );
}
