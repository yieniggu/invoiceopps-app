/** The slice of a TanStack query that loading and error feedback needs. */
interface QueryLike {
  isPending: boolean;
  isError: boolean;
  data: unknown;
  refetch: () => Promise<unknown>;
}

/**
 * Accessible loading and failure feedback of one read: a status while it
 * loads and an alert with a retry button when it fails. When a refresh fails
 * while data is on screen, `staleError` says what is shown may be outdated.
 */
export function QueryFeedback({
  query,
  loading,
  error,
  staleError,
  retryLabel,
}: {
  query: QueryLike;
  loading: string;
  error: string;
  staleError?: string;
  retryLabel: string;
}) {
  return (
    <>
      {query.isError ? (
        <>
          <p role="alert">
            {query.data !== undefined ? (staleError ?? error) : error}
          </p>
          <button type="button" onClick={() => void query.refetch()}>
            {retryLabel}
          </button>
        </>
      ) : null}
      {query.data === undefined && query.isPending ? (
        <p role="status">{loading}</p>
      ) : null}
    </>
  );
}
