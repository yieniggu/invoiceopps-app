import { useEffect, useRef, useState } from "react";

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
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  // Focus returns to the trigger once it is back in the DOM (synchronisation).
  useEffect(() => {
    if (!confirming && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [confirming]);

  if (!confirming) {
    return (
      <button
        ref={trigger}
        type="button"
        className="danger-button"
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        {label}
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
}
