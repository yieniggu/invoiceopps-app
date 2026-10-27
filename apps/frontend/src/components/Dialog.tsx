import {
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog: focus moves in on open, Tab stays inside, Escape closes and
 * focus returns to `returnFocusTo` (or to what had focus before it opened).
 */
export function Dialog({
  title,
  onClose,
  returnFocusTo,
  children,
}: {
  title: string;
  onClose: () => void;
  returnFocusTo?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  // Focus management is DOM synchronisation: move in on open, restore on close.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => (returnFocusTo?.current ?? previous)?.focus?.();
  }, [returnFocusTo]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const targets = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
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

  return (
    <div className="dialog-backdrop">
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
    </div>
  );
}
