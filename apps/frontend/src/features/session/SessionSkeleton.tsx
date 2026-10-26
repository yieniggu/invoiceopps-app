import { useEffect, useState } from "react";

import { readSidebarCollapsed } from "../navigation/AppShell";

// Avoid a skeleton flash on fast session checks.
const SKELETON_DELAY_MS = 300;
const STATUS_TEXT = "Preparando tu espacio de trabajo";

export function SessionSkeleton() {
  const [visible, setVisible] = useState(false);
  // The status text is inserted after mount so assistive technology announces it.
  const [announced, setAnnounced] = useState(false);
  const [collapsed] = useState(readSidebarCollapsed);
  useEffect(() => {
    setAnnounced(true);
    const timer = setTimeout(() => setVisible(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <main className="session-skeleton" aria-label={STATUS_TEXT}>
      <p role="status" className="visually-hidden">
        {announced ? STATUS_TEXT : null}
      </p>
      {visible ? (
        <div
          className={`skeleton-layout${collapsed ? " is-collapsed" : ""}`}
          aria-busy="true"
          aria-hidden="true"
        >
          <div className="skeleton-sidebar">
            <span className="skeleton-block skeleton-brand" />
            <span className="skeleton-block skeleton-nav-item" />
            <span className="skeleton-block skeleton-nav-item" />
            <span className="skeleton-block skeleton-nav-item" />
            <span className="skeleton-block skeleton-nav-item" />
          </div>
          <div className="skeleton-main">
            <span className="skeleton-block skeleton-header" />
            <span className="skeleton-block skeleton-intro" />
            <span className="skeleton-block skeleton-card skeleton-card-wide" />
            <div className="skeleton-cards">
              <span className="skeleton-block skeleton-card" />
              <span className="skeleton-block skeleton-card" />
              <span className="skeleton-block skeleton-card" />
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
