import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import { Dialog } from "../../../components/Dialog";
import { formatInstant } from "../../../lib/datetime";
import type { IssuedApiToken } from "../types";

type CopyState = "idle" | "copied" | "manual";

/**
 * The only place the secret of a new token is ever shown. It lives in this
 * dialog's props until the person confirms, then it is gone: nothing here
 * writes it anywhere. The dialog does not close by accident: Escape moves
 * focus to the confirmation button. «Copiar» writes to the clipboard only on
 * click; if the browser refuses, the text is selected for a manual copy.
 */
export function ApiTokenSecretDialog({
  issued,
  onClose,
  returnFocusTo,
}: {
  issued: IssuedApiToken;
  onClose: () => void;
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<CopyState>("idle");

  const copySecret = async () => {
    try {
      await navigator.clipboard.writeText(issued.secret);
      setCopy("copied");
    } catch {
      // No clipboard API or permission: select it for Ctrl+C. Never stored.
      field.current?.select();
      setCopy("manual");
    }
  };

  // Focus starts on the confirmation after the Dialog itself took it, and a
  // browser Back/Forward must not strand it outside the dialog.
  useLayoutEffect(() => {
    confirm.current?.focus();
  }, []);
  useEffect(() => {
    const keepFocusInside = () => {
      window.setTimeout(() => {
        const panel = confirm.current?.closest('[role="dialog"]');
        if (panel && !panel.contains(document.activeElement))
          confirm.current?.focus();
      }, 0);
    };
    window.addEventListener("popstate", keepFocusInside);
    return () => window.removeEventListener("popstate", keepFocusInside);
  }, []);

  const message =
    copy === "copied"
      ? "Copiado"
      : copy === "manual"
        ? "No pudimos copiarlo automáticamente. Selecciona el token y cópialo manualmente con Ctrl+C (⌘C en Mac)."
        : "";

  return (
    <Dialog
      title="Token emitido"
      onClose={onClose}
      onEscape={() => confirm.current?.focus()}
      returnFocusTo={returnFocusTo}
    >
      <div className="confirm-dialog">
        <p>
          Se emitió el token «{issued.token.name}». Úsalo como credencial
          «Authorization: Bearer» en tus integraciones.
        </p>
        <p>Vence el {formatInstant(issued.token.expiresAt)}</p>
        <p>
          <strong>
            No podrás volver a verlo. Cópialo y guárdalo en un lugar seguro.
          </strong>
        </p>
        <div className="form-field">
          <label htmlFor="api-token-secret">Token de acceso</label>
          <input
            id="api-token-secret"
            ref={field}
            className="secret-value"
            readOnly
            value={issued.secret}
            autoComplete="off"
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
        <p className="field-hint">
          Copiar no limpia el portapapeles del sistema: bórralo tú cuando ya no
          lo necesites.
        </p>
        <div className="action-row">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void copySecret()}
          >
            Copiar
          </button>
          <button ref={confirm} type="button" onClick={onClose}>
            Ya guardé el token
          </button>
        </div>
        <p role="status" aria-live="polite" className="muted">
          {message}
        </p>
      </div>
    </Dialog>
  );
}
