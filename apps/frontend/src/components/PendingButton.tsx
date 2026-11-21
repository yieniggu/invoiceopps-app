import type { ButtonHTMLAttributes } from "react";

import { LiveStatus } from "./LiveStatus";
import { PendingLabel } from "./PendingLabel";

/**
 * A button whose request is in flight: the label stays, a spinner sits over
 * it (`PendingLabel`) and the button is `aria-busy`. With `announce` a hidden
 * live region says when it starts and, if `done` is given, when it succeeds
 * (`LiveStatus`), so the sighted spinner and the spoken status are one signal.
 */
export function PendingButton({
  pending,
  announce,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  pending: boolean;
  announce?: { pending: string; done?: string; succeeded?: boolean };
}) {
  return (
    <>
      <button
        {...rest}
        className={
          pending
            ? [className, "is-pending"].filter(Boolean).join(" ")
            : className
        }
        aria-busy={pending || undefined}
      >
        <PendingLabel pending={pending}>{children}</PendingLabel>
      </button>
      {announce ? (
        <LiveStatus
          pending={pending}
          succeeded={announce.succeeded ?? false}
          pendingText={announce.pending}
          doneText={announce.done ?? ""}
        />
      ) : null}
    </>
  );
}
