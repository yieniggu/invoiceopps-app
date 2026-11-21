import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Content of a button whose request is in flight: the label stays (so the
 * width and the accessible name do not change) and a spinner is centered over
 * it. Put `is-pending` on the button and `aria-busy={pending}`.
 */
export function PendingLabel({
  pending,
  children,
}: {
  pending: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <span className="pending-label">{children}</span>
      {pending ? (
        <Loader2
          className="pending-spinner icon-spin"
          aria-hidden="true"
          focusable="false"
          size={16}
        />
      ) : null}
    </>
  );
}
