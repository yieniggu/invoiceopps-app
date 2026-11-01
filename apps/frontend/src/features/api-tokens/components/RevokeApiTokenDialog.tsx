import type { RefObject } from "react";

import { Dialog } from "../../../components/Dialog";
import { describeTokenFailure } from "../apiTokenScopes";
import type { ApiToken } from "../types";

/**
 * Asks before revoking. While the request runs nothing dismisses the dialog;
 * the confirm button is `aria-disabled` (not `disabled`, which would drop the
 * focus it holds) and its click is ignored, so a double click sends one DELETE.
 */
export function RevokeApiTokenDialog({
  token,
  pending,
  failure,
  onConfirm,
  onClose,
  returnFocusTo,
}: {
  token: Pick<ApiToken, "name">;
  pending: boolean;
  failure: { error: unknown } | undefined;
  onConfirm: () => void;
  onClose: () => void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const close = () => {
    if (!pending) onClose();
  };
  return (
    <Dialog title="Revocar token" onClose={close} returnFocusTo={returnFocusTo}>
      <div className="confirm-dialog">
        <p>
          ¿Revocar el token «{token.name}»? Dejará de funcionar de inmediato y
          no se puede deshacer.
        </p>
        {failure ? (
          <p role="alert">{describeTokenFailure(failure.error, "revoke")}</p>
        ) : null}
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
            {pending ? "Revocando…" : "Revocar token"}
          </button>
        </div>
        <p role="status">{pending ? "Revocando el token…" : ""}</p>
      </div>
    </Dialog>
  );
}
