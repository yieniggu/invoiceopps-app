/**
 * Previous / next controls of a paginated list: "Página X de Y" is a polite
 * live region, and each button is disabled at its end of the range.
 */
export function PaginationControls({
  page,
  pageSize,
  total,
  onPageChange,
  label = "Paginación",
  busy = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  label?: string;
  /** The next page is loading: both buttons wait. */
  busy?: boolean;
}) {
  const pages = Math.max(1, Math.ceil((total || 0) / pageSize));
  return (
    <div className="action-row pagination" role="group" aria-label={label}>
      <button
        type="button"
        className="secondary-button"
        disabled={busy || page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        Anterior
      </button>
      <p role="status" aria-live="polite" className="muted">
        Página {page} de {pages}
      </p>
      <button
        type="button"
        className="secondary-button"
        disabled={busy || page >= pages}
        onClick={() => onPageChange(page + 1)}
      >
        Siguiente
      </button>
    </div>
  );
}
