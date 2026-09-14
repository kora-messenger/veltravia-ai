import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface TabDef {
  id: string;
  label: string;
  content: ReactNode;
}

export interface TabsProps {
  tabs: readonly TabDef[];
  /** Accessible label for the whole tab list. */
  'aria-label': string;
  initialTabId?: string;
}

/**
 * Accessible tabs: roving tabindex, ArrowLeft/ArrowRight/Home/End navigation,
 * aria-controls/aria-selected wiring, lazy-free but only the active tab
 * panel stays mounted.
 */
export function Tabs({ tabs, 'aria-label': ariaLabel, initialTabId }: TabsProps) {
  const [activeId, setActiveId] = useState<string>(initialTabId ?? tabs[0]?.id ?? '');
  const baseId = useId();

  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeId),
  );

  const move = (delta: number) => {
    if (tabs.length === 0) return;
    const next = (activeIndex + delta + tabs.length) % tabs.length;
    setActiveId(tabs[next]?.id ?? '');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveId(tabs[0]?.id ?? '');
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveId(tabs[tabs.length - 1]?.id ?? '');
    }
  };

  return (
    <div className="v-tabs">
      <div role="tablist" aria-label={ariaLabel} className="v-tabs__list" onKeyDown={handleKeyDown}>
        {tabs.map((tab) => {
          const selected = tab.id === activeId;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={selected ? 'v-tabs__tab v-tabs__tab--active' : 'v-tabs__tab'}
              onClick={() => setActiveId(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => {
        if (tab.id !== activeId) return null;
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={`${baseId}-panel-${tab.id}`}
            aria-labelledby={`${baseId}-tab-${tab.id}`}
            className="v-tabs__panel"
          >
            {tab.content}
          </div>
        );
      })}
    </div>
  );
}
