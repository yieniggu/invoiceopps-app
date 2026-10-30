import type { RefObject } from "react";

import { Dialog } from "../../../components/Dialog";
import type { Invoice } from "../types";

/**
 * Asks before deleting. While the request runs nothing dismisses the dialog;
 * the confirm button says «Eliminando…», is announced as busy and is
 * `aria-disabled` (not `disabled`, which would drop the focus it holds), and
 * its click is ignored, so a double click sends one DELETE.
 */
export function DeleteInvoiceDialog({
  invoice,
  pending,
  onConfirm,
  onClose,
  returnFocusTo,
}: {
  invoice: Pick<Invoice, "businessId" | "supplierName">;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const close = () => {
    if (!pending) onClose();
  };
  return (
    <Dialog
      title="Eliminar factura"
      onClose={close}
      returnFocusTo={returnFocusTo}
    >
      <div className="confirm-dialog">
        <p>
          ¿Eliminar la factura {invoice.businessId} de {invoice.supplierName}?
          La factura dejará de aparecer en las listas.
        </p>
        <div className="action-row">
          <button
            type="button"
            className="secondary-button"
            disabled={pending}
            onClick={close}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="danger-button"
            aria-disabled={pending || undefined}
            onClick={() => {
              if (!pending) onConfirm();
            }}
          >
            {pending ? "Eliminando…" : "Eliminar factura"}
          </button>
        </div>
        {/* Present from the start so the change is announced. */}
        <p role="status">{pending ? "Eliminando la factura…" : ""}</p>
      </div>
    </Dialog>
  );
}
