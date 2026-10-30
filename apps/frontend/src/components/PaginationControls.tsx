/**
 * Previous / next controls of a paginated list: "Página X de Y" is a polite
 * live region. A button that cannot act (at its end of the range, or while the
 * next page loads, `busy`) is `aria-disabled` and ignores clicks instead of
 * being `disabled`, so the focused one keeps keyboard focus: reaching the last
 * page with «Siguiente» does not drop the focus to the document.
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
  /** The next page is loading: both buttons wait (and keep focus). */
  busy?: boolean;
}) {
  const pages = Math.max(1, Math.ceil((total || 0) / pageSize));
  const atStart = page <= 1;
  const atEnd = page >= pages;
  return (
    <div className="action-row pagination" role="group" aria-label={label}>
      <button
        type="button"
        className="secondary-button"
        aria-disabled={busy || atStart || undefined}
        onClick={() => {
          if (!busy && !atStart) onPageChange(page - 1);
        }}
      >
        Anterior
      </button>
      <p role="status" aria-live="polite" className="muted">
        Página {page} de {pages}
      </p>
      <button
        type="button"
        className="secondary-button"
        aria-disabled={busy || atEnd || undefined}
        onClick={() => {
          if (!busy && !atEnd) onPageChange(page + 1);
        }}
      >
        Siguiente
      </button>
    </div>
  );
}
