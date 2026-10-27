import type { RefObject } from "react";

import { Dialog } from "../../../components/Dialog";
import type { IssuedCredential } from "../types";

/** The only place the one-time password lives: provider memory until closed. */
export function TemporaryPasswordDialog({
  credential,
  onClose,
  returnFocusTo,
}: {
  credential: IssuedCredential;
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog
      title="Contraseña temporal"
      onClose={onClose}
      returnFocusTo={returnFocusTo}
    >
      <p>
        Entrega esta contraseña a {credential.name}. Solo se muestra ahora: al
        cerrar este cuadro no podrás verla de nuevo y deberá cambiarla al
        iniciar sesión.
      </p>
      <code className="secret-value">{credential.temporaryPassword}</code>
      <button type="button" onClick={onClose}>
        Cerrar
      </button>
    </Dialog>
  );
}
