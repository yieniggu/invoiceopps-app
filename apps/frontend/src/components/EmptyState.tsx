import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Friendly "nothing here" block: tinted icon, title, muted description and an
 * optional action. It grows to fill the free space of a `.screen-fill`
 * screen and centers itself in it.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  headingLevel = 2,
  compact = false,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Level of the title; inside a section that already has an `h2`, pass 3. */
  headingLevel?: 2 | 3;
  /** Quiet inline variant: no dashed box, small icon, no forced height. */
  compact?: boolean;
}) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <div className={compact ? "empty-state is-compact" : "empty-state"}>
      <span className="empty-state-icon" aria-hidden="true">
        <Icon focusable="false" size={32} />
      </span>
      <Heading className="empty-state-title">{title}</Heading>
      {description ? (
        <p className="empty-state-description">{description}</p>
      ) : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}
