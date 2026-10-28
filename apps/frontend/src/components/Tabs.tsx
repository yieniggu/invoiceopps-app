import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface TabDefinition {
  id: string;
  label: string;
  panel: ReactNode;
}

/**
 * Accessible tabs: roving tabindex, arrow keys, Home and End. Every panel
 * stays mounted (hidden when inactive) so a half-filled form survives
 * switching tabs.
 */
export function Tabs({
  label,
  tabs,
}: {
  label: string;
  tabs: readonly TabDefinition[];
}) {
  const prefix = useId();
  const [activeId, setActiveId] = useState(tabs[0]?.id);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const select = (index: number) => {
    const target = tabs[(index + tabs.length) % tabs.length];
    if (!target) return;
    setActiveId(target.id);
    buttons.current.get(target.id)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === "ArrowRight") select(index + 1);
    else if (event.key === "ArrowLeft") select(index - 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(tabs.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} className="tab-list">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) buttons.current.set(tab.id, node);
              else buttons.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={`${prefix}-tab-${tab.id}`}
            className="tab"
            aria-selected={tab.id === activeId}
            aria-controls={`${prefix}-panel-${tab.id}`}
            tabIndex={tab.id === activeId ? 0 : -1}
            onClick={() => setActiveId(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${prefix}-panel-${tab.id}`}
          aria-labelledby={`${prefix}-tab-${tab.id}`}
          hidden={tab.id !== activeId}
          className="tab-panel"
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
