import type { Ref } from "react";
import { ToggleLeft, ToggleRight } from "lucide-react";

import { PendingLabel } from "./PendingLabel";

/**
 * A two-state switch as a button (`role="switch"`, state in `aria-checked`).
 * The visible text is `label`; `context` adds hidden words after it, so the
 * accessible name always starts with what is on screen («Inferencia» +
 * « en facturas nuevas de X versión 3»). The icon shows the state without
 * relying on color. `locked` and `pending` use `aria-disabled` (a disabled
 * control that has focus sends it to the page) and ignore clicks.
 */
export function SwitchButton({
  label,
  context,
  checked,
  pending = false,
  locked = false,
  title,
  onToggle,
  ref,
}: {
  label: string;
  context?: string;
  checked: boolean;
  pending?: boolean;
  locked?: boolean;
  title?: string;
  onToggle: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  const Icon = checked ? ToggleRight : ToggleLeft;
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      className={
        pending
          ? "secondary-button switch-button is-pending"
          : "secondary-button switch-button"
      }
      aria-busy={pending || undefined}
      aria-disabled={locked || pending ? true : undefined}
      title={title}
      onClick={() => {
        if (!locked && !pending) onToggle();
      }}
    >
      <PendingLabel pending={pending}>
        <Icon aria-hidden="true" focusable="false" size={18} />
        <span>{label}</span>
        {context ? (
          <>
            {" "}
            <span className="visually-hidden">{context}</span>
          </>
        ) : null}
      </PendingLabel>
    </button>
  );
}
