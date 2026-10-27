import { useLayoutEffect, type ReactNode } from "react";

/**
 * Title, one-line description and the primary action of a screen. It owns the
 * page `h1` (the shell moves focus to it on navigation) and the tab title.
 */
export function PageHeader({
  title,
  description,
  action,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Small label above the title, e.g. the organization a group belongs to. */
  eyebrow?: ReactNode;
}) {
  useLayoutEffect(() => {
    document.title = `${title} · InvoiceOps`;
  }, [title]);

  return (
    <header className="page-header">
      <div className="page-header-text">
        {eyebrow ? <p className="page-eyebrow">{eyebrow}</p> : null}
        <h1 id="page-title" tabIndex={-1}>
          {title}
        </h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {action ? <div className="page-header-action">{action}</div> : null}
    </header>
  );
}
