import { LiveStatus } from "./LiveStatus";
import { PendingLabel } from "./PendingLabel";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";

/**
 * A destructive action that asks first: the trigger swaps for a confirm and a
 * cancel button. Confirming runs `onConfirm`; confirming or cancelling returns
 * focus to the trigger (the confirm button that had it is gone). If the action
 * fails, the screen's error alert takes focus (see `MutationFeedback`
 * `focusOnError`); if it succeeds and the trigger leaves the page, the screen
 * decides where focus goes.
 */
export function ConfirmAction({
  label,
  confirmLabel,
  disabled = false,
  pending = false,
  announce,
  onConfirm,
  triggerRef,
  renderTrigger,
}: {
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  /** The action is running: spinner over the trigger, `aria-busy`. */
  pending?: boolean;
  /** Spoken while `pending` (hidden live region, like `PendingButton`). */
  announce?: string;
  onConfirm: () => void;
  /** Lets a flow that finishes later (a dialog) return focus to the trigger. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /**
   * Draws a different trigger (a switch): it must call `open`, set `ref` on
   * its button and lock itself when `locked`. `label` is then only the
   * default trigger's text.
   */
  renderTrigger?: (control: {
    open: () => void;
    ref: Ref<HTMLButtonElement>;
    locked: boolean;
  }) => ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);

  // Focus returns to the trigger once it is back in the DOM (synchronisation).
  useEffect(() => {
    if (!confirming && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [confirming]);

  const setTrigger = (node: HTMLButtonElement | null) => {
    trigger.current = node;
    if (triggerRef) triggerRef.current = node;
  };
  const locked = disabled || pending;

  const control = (() => {
    if (!confirming) {
      if (renderTrigger)
        return renderTrigger({
          open: () => setConfirming(true),
          ref: setTrigger,
          locked,
        });
      return (
        <button
          ref={setTrigger}
          type="button"
          className={pending ? "danger-button is-pending" : "danger-button"}
          aria-disabled={locked || undefined}
          aria-busy={pending || undefined}
          onClick={() => {
            if (!locked) setConfirming(true);
          }}
        >
          <PendingLabel pending={pending}>{label}</PendingLabel>
        </button>
      );
    }
    return (
      <>
        <button
          type="button"
          className="danger-button"
          autoFocus
          disabled={disabled}
          onClick={() => {
            restoreFocus.current = true;
            setConfirming(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            restoreFocus.current = true;
            setConfirming(false);
          }}
        >
          Cancelar
        </button>
      </>
    );
  })();
  return (
    <>
      {control}
      {announce ? (
        <LiveStatus
          pending={pending}
          succeeded={false}
          pendingText={announce}
          doneText=""
        />
      ) : null}
    </>
  );
}
