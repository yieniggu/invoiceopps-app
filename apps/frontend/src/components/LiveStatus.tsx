import { useState } from "react";

/**
 * Visually hidden `role="status"` that announces a mutation: `pendingText`
 * while it runs and `doneText` when it succeeds. A failure is announced by the
 * screen's own alert, so the region just empties. Sighted users get the
 * spinner of the button and the changed content; this is the screen reader
 * side of the same single signal.
 */
export function LiveStatus({
  pending,
  succeeded,
  pendingText,
  doneText,
}: {
  pending: boolean;
  succeeded: boolean;
  pendingText: string;
  doneText: string;
}) {
  const [text, setText] = useState("");
  const [wasPending, setWasPending] = useState(false);
  // Derived state, adjusted while rendering when the mutation changes phase.
  if (pending !== wasPending) {
    setWasPending(pending);
    setText(pending ? pendingText : succeeded ? doneText : "");
  }
  return (
    <p role="status" className="visually-hidden">
      {text}
    </p>
  );
}
