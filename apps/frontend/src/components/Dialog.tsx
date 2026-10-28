import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

const focusableIn = (panel: HTMLElement) => [
  ...panel.querySelectorAll<HTMLElement>(FOCUSABLE),
];

/**
 * Modal dialog: focus moves in on open, Tab stays inside, Escape closes and
 * focus returns to `returnFocusTo` (or to what had focus before it opened).
 * If that element left the page meanwhile, is disabled, or there was none,
 * focus lands on the page title.
 * The dialog is rendered straight into `document.body` and every other child
 * of `body` (the app) is made `inert` while it is open, so neither Tab nor a
 * screen reader reaches the page behind it. A document-level key handler
 * covers the case where focus is on `body` (nothing inside the dialog has
 * it): Escape still acts and Tab moves focus into the dialog.
 * A dialog whose content must not be dismissed by accident passes `onEscape`:
 * Escape then calls it instead of `onClose` (e.g. to move focus to the one
 * button that confirms and closes).
 */
export function Dialog({
  title,
  onClose,
  onEscape,
  returnFocusTo,
  children,
}: {
  title: string;
  onClose: () => void;
  onEscape?: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  // Latest handlers for the document-level listener, which is bound once.
  const escape = useRef(onEscape ?? onClose);
  escape.current = onEscape ?? onClose;

  // Focus management is DOM synchronisation: move in on open, restore on close.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Everything else on the page is unreachable while the dialog is open.
    const inerted = [...document.body.children].filter(
      (element): element is HTMLElement =>
        element !== backdrop.current &&
        element instanceof HTMLElement &&
        !element.hasAttribute("inert"),
    );
    for (const element of inerted) element.setAttribute("inert", "");
    panel.current?.focus();
    return () => {
      for (const element of inerted) element.removeAttribute("inert");
      const target = returnFocusTo?.current ?? previous;
      // `body` is what holds focus when the opener vanished before the dialog
      // opened (the screen changed in the same render), and a disabled button
      // (e.g. "Creando...", confirmed before the success screen rendered)
      // cannot take focus: neither is a place to return to, so both fall back
      // to the page title like a removed opener.
      const reachable =
        target !== null &&
        target !== document.body &&
        target.isConnected &&
        !target.matches(":disabled");
      if (reachable) target.focus();
      if (!reachable || document.activeElement !== target)
        document.getElementById("page-title")?.focus();
    };
  }, [returnFocusTo]);

  // Focus on `body` (or anywhere outside the panel): keys still reach the
  // dialog instead of the page behind it.
  useEffect(() => {
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      const dialog = panel.current;
      if (!dialog || dialog.contains(event.target as Node | null)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        escape.current();
      } else if (event.key === "Tab") {
        event.preventDefault();
        const targets = focusableIn(dialog);
        const next = event.shiftKey ? targets[targets.length - 1] : targets[0];
        (next ?? dialog).focus();
      }
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      (onEscape ?? onClose)();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const targets = focusableIn(panel.current);
    if (targets.length === 0) {
      event.preventDefault();
      return;
    }
    const first = targets[0];
    const last = targets[targets.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div ref={backdrop} className="dialog-backdrop">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="dialog-panel"
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
