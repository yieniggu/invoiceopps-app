import { useEffect, useRef } from "react";

import { describeError } from "../features/auth/api/apiError";

/**
 * Accessible outcome of a mutation: alert on failure, status on success. With
 * `focusOnError` the alert takes focus when a failure appears, for actions
 * whose trigger disappears while they run (so keyboard and screen reader users
 * land on the reason instead of on nothing).
 */
export function MutationFeedback({
  isError,
  error,
  isSuccess,
  success,
  fallback,
  focusOnError = false,
}: {
  isError: boolean;
  error: unknown;
  isSuccess: boolean;
  success: string;
  fallback: string;
  focusOnError?: boolean;
}) {
  const alert = useRef<HTMLParagraphElement>(null);
  // Focus is DOM synchronisation: move it when the failure appears.
  useEffect(() => {
    if (isError && focusOnError) alert.current?.focus();
  }, [isError, focusOnError]);

  return (
    <>
      {isError ? (
        <p ref={alert} role="alert" tabIndex={focusOnError ? -1 : undefined}>
          {describeError(error, fallback)}
        </p>
      ) : null}
      {isSuccess ? <p role="status">{success}</p> : null}
    </>
  );
}
