import { Skeleton } from "./Skeleton";

/** The slice of a TanStack query that loading and error feedback needs. */
interface QueryLike {
  isPending: boolean;
  isError: boolean;
  data: unknown;
  refetch: () => Promise<unknown>;
}

/**
 * Loading and failure feedback of one read: a skeleton while it loads (no
 * visible text; `loadingLabel` is its hidden announcement) and an alert with a retry button when it
 * fails. When a refresh fails
 * while data is on screen, `staleError` says what is shown may be outdated.
 */
type SkeletonProps =
  | {
      /** Rows of the skeleton shown while loading. */
      skeleton: number;
      /** Hidden announcement of the initial load (required, CR-587), e.g. «Cargando despliegues». */
      loadingLabel: string;
    }
  | {
      /** Omit the skeleton when the screen draws its own. */
      skeleton?: undefined;
      loadingLabel?: undefined;
    };

export function QueryFeedback({
  query,
  skeleton,
  loadingLabel,
  error,
  staleError,
  retryLabel,
}: {
  query: QueryLike;
  error: string;
  staleError?: string;
  retryLabel: string;
} & SkeletonProps) {
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
      {skeleton &&
      loadingLabel &&
      query.data === undefined &&
      query.isPending ? (
        <Skeleton rows={skeleton} label={loadingLabel} />
      ) : null}
    </>
  );
}
