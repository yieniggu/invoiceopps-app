import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import { Dialog } from "../../../components/Dialog";
import type { IssuedCredential } from "../types";

type CopyState = "idle" | "copied" | "selected";

/** Puts the whole text of `node` in the selection, ready for Ctrl+C. */
function selectContents(node: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/**
 * The only place the one-time password lives: provider memory until the
 * person confirms. The dialog is the only copy they will ever see, so it does
 * not close by accident: Escape moves focus to the confirmation button and
 * only "Ya copié la contraseña" closes it. Focus starts on that button and
 * stays inside the dialog across history navigation; on close it goes back to
 * the trigger if it is still mounted, else to the page title (see `Dialog`). "Copiar" uses the clipboard API and
 * falls back to selecting the text when the clipboard is unavailable.
 */
export function TemporaryPasswordDialog({
  credential,
  onClose,
  returnFocusTo,
}: {
  credential: IssuedCredential;
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  const secret = useRef<HTMLElement>(null);
  const [copy, setCopy] = useState<CopyState>("idle");

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(credential.temporaryPassword);
      setCopy("copied");
    } catch {
      // No clipboard permission or API: select the text so the person can
      // copy it with the keyboard.
      if (secret.current) selectContents(secret.current);
      setCopy("selected");
    }
  };

  // The acknowledge button is the dialog's live control: focus starts there
  // (after the Dialog itself took it), and a browser Back/Forward that swaps
  // the page behind the dialog must not leave it on something that vanished.
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
      ? "Contraseña copiada al portapapeles."
      : copy === "selected"
        ? "No pudimos copiarla automáticamente. La contraseña quedó seleccionada: cópiala con Ctrl+C (⌘C en Mac)."
        : "";

  return (
    <Dialog
      title="Contraseña temporal"
      onClose={onClose}
      onEscape={() => confirm.current?.focus()}
      returnFocusTo={returnFocusTo}
    >
      <p>
        Entrega esta contraseña a {credential.name}. Solo se muestra ahora: al
        cerrar este cuadro no podrás verla de nuevo y deberá cambiarla al
        iniciar sesión.
      </p>
      <code ref={secret} className="secret-value">
        {credential.temporaryPassword}
      </code>
      <div className="action-row">
        <button
          type="button"
          className="secondary-button"
          onClick={copyPassword}
        >
          Copiar
        </button>
        <button ref={confirm} type="button" onClick={onClose}>
          Ya copié la contraseña
        </button>
      </div>
      <p role="status" aria-live="polite" className="muted">
        {message}
      </p>
    </Dialog>
  );
}
