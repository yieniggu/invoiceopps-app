import { useEffect, useState } from "react";

/**
 * Placeholder blocks shaped like the content that is loading. The container
 * carries `aria-busy` (a skeleton only shows on an initial or foreground
 * load, never on a background poll); the blocks are decorative. Motion
 * respects `prefers-reduced-motion` (see `.skeleton-block`).
 *
 * `label` is the one accessible announcement of the load («Cargando
 * despliegues», no ellipsis): a visually hidden `role="status"` outside the
 * busy container, inserted after mount so assistive technology speaks it.
 */
export function Skeleton({
  rows = 3,
  rowClassName = "skeleton-row",
  className,
  label,
}: {
  rows?: number;
  /** Shape of one block: `skeleton-row` (table row) or `skeleton-card`. */
  rowClassName?: string;
  className?: string;
  /** Screen-reader-only text announcing what is loading. */
  label: string;
}) {
  const [announced, setAnnounced] = useState(false);
  useEffect(() => setAnnounced(true), []);
  return (
    <>
      <span role="status" className="visually-hidden">
        {announced ? label : null}
      </span>
      <div
        className={className ? `skeleton-stack ${className}` : "skeleton-stack"}
        aria-busy="true"
        data-testid="skeleton"
      >
        {Array.from({ length: rows }, (_, index) => (
          <span
            key={index}
            className={`skeleton-block ${rowClassName}`}
            aria-hidden="true"
          />
        ))}
      </div>
    </>
  );
}
