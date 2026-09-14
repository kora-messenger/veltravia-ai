import type { ReactNode } from 'react';
import { ROUTES, type RouteDef } from './useHashRoute';

const ICONS: Record<string, ReactNode> = {
  dashboard: (
    <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
      <rect
        x="2"
        y="2"
        width="5"
        height="5"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="9"
        y="2"
        width="5"
        height="5"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="2"
        y="9"
        width="5"
        height="5"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <rect
        x="9"
        y="9"
        width="5"
        height="5"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  ),
  projects: (
    <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
      <path
        d="M2 4.5h12M2 4.5a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 14 4.5v7A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M6 8h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
};

export interface SidebarProps {
  activeRouteId: string;
  onNavigate(route: RouteDef): void;
  collapsed: boolean;
  onToggleCollapse(): void;
  /** Drawer mode: overlay panel for small viewports. */
  mobileOpen: boolean;
  onMobileClose(): void;
}

export function Sidebar({
  activeRouteId,
  onNavigate,
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onMobileClose,
}: SidebarProps) {
  return (
    <>
      {mobileOpen && <div className="v-shell__backdrop" onClick={onMobileClose} />}
      <nav
        className={[
          'v-sidebar',
          collapsed ? 'v-sidebar--collapsed' : '',
          mobileOpen ? 'v-sidebar--mobile-open' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-label="Primary"
        data-testid="sidebar"
      >
        <div className="v-sidebar__header">
          <a className="v-sidebar__brand" href="#/dashboard" onClick={onMobileClose}>
            <span className="v-sidebar__logo" aria-hidden="true">
              V
            </span>
            {!collapsed && <span className="v-sidebar__brand-name">Veltravia AI</span>}
          </a>
          <button
            type="button"
            className="v-sidebar__collapse"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            onClick={onToggleCollapse}
          >
            <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
              <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>

        <ul className="v-sidebar__nav">
          {ROUTES.map((route) => {
            const active = route.id === activeRouteId;
            return (
              <li key={route.id}>
                <a
                  href={route.hash}
                  className={active ? 'v-sidebar__link v-sidebar__link--active' : 'v-sidebar__link'}
                  aria-current={active ? 'page' : undefined}
                  title={collapsed ? route.title : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(route);
                    onMobileClose();
                  }}
                >
                  {ICONS[route.id]}
                  {!collapsed && <span>{route.title}</span>}
                </a>
              </li>
            );
          })}
        </ul>

        <div className="v-sidebar__footer">
          {!collapsed && <span className="v-caption">Platform preview — under development</span>}
        </div>
      </nav>
    </>
  );
}
