import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, type ReactNode } from "react";

/**
 * Card whose body can be folded away behind a chevron button. The heading
 * wraps the toggle (the standard accordion pattern), the toggle reports
 * `aria-expanded` and points at the body with `aria-controls`; the body stays
 * mounted (hidden) so its state survives folding, unless `renderFolded` is
 * false: then a folded body renders nothing (for long lists whose state lives
 * in the parent, so a card costs nothing until it is opened). While folded, a one-line
 * `summary` describes what is inside. With `collapsible={false}` it is a plain
 * always-open card with the same look.
 */
export function CollapsibleSection({
  title,
  summary,
  open,
  onToggle,
  collapsible = true,
  renderFolded = true,
  headingLevel = 3,
  actions,
  className,
  children,
}: {
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  collapsible?: boolean;
  /** Keep the body mounted (hidden) while folded. Default true. */
  renderFolded?: boolean;
  headingLevel?: 3 | 4;
  /** Controls kept next to the toggle (e.g. "Quitar ..."). */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const bodyId = useId();
  const summaryId = useId();
  const Heading = headingLevel === 3 ? "h3" : "h4";
  const expanded = collapsible ? open : true;
  return (
    <section
      className={["context-card", "collapsible", className]
        .filter(Boolean)
        .join(" ")}
      aria-labelledby={titleId}
    >
      <div className="collapsible-header">
        <Heading id={titleId} className="card-title collapsible-title">
          {collapsible ? (
            <button
              type="button"
              className="collapse-toggle"
              aria-expanded={expanded}
              aria-controls={bodyId}
              aria-describedby={expanded ? undefined : summaryId}
              onClick={onToggle}
            >
              {expanded ? (
                <ChevronDown aria-hidden="true" focusable="false" size={18} />
              ) : (
                <ChevronRight aria-hidden="true" focusable="false" size={18} />
              )}
              <span>{title}</span>
            </button>
          ) : (
            title
          )}
        </Heading>
        {actions}
      </div>
      {expanded ? null : (
        <p id={summaryId} className="collapsible-summary">
          {summary}
        </p>
      )}
      <div id={bodyId} className="collapsible-body" hidden={!expanded}>
        {expanded || renderFolded ? children : null}
      </div>
    </section>
  );
}
