import { describeError } from "../features/auth/api/apiError";

/** Accessible outcome of a mutation: alert on failure, status on success. */
export function MutationFeedback({
  isError,
  error,
  isSuccess,
  success,
  fallback,
}: {
  isError: boolean;
  error: unknown;
  isSuccess: boolean;
  success: string;
  fallback: string;
}) {
  return (
    <>
      {isError ? <p role="alert">{describeError(error, fallback)}</p> : null}
      {isSuccess ? <p role="status">{success}</p> : null}
    </>
  );
}
