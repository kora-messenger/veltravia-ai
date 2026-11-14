import { useState, type ReactNode } from 'react';
import { BrandMark } from '../components/brand/BrandMark';
import {
  AI_WORKSPACE_IDS,
  AI_WORKSPACE_LABEL,
  ROUTES,
  isAiWorkspaceRoute,
  type RouteDef,
} from './useHashRoute';

const ICONS: Record<string, ReactNode> = {
  chat: (
    <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
      <path
        d="M2.5 7.2c0-2.2 2.2-4 4.9-4h1.2c2.7 0 4.9 1.8 4.9 4s-2.2 4-4.9 4H7l-3 2.1v-2.5c-.9-.7-1.5-1.9-1.5-3.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  ),
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
  files: (
    <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
      <path d="M3 2.5h6l4 4v7H3Z" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M9 2.5v4h4M5.5 9h5M5.5 11.5h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  ),
  audio: (
    <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
      <path
        d="M3 6.5v3M6 4v8M9 5.5v5M12 7v2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),

  video: (
    <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
      <rect
        x="2"
        y="3"
        width="9"
        height="10"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M11 6L14 4V12L11 10" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  documents: (
    <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
      <path
        d="M4 2h5l3 3v9H4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M9 2v3h3M6 8h4M6 11h4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  image: (
    <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
      <rect
        x="3"
        y="3"
        width="10"
        height="10"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M3.5 10.5 6 8l2.5 2.5L10 9l2.5 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="6" cy="6" r="0.9" fill="currentColor" />
    </svg>
  ),
  // A ledger sheet: usage is a record of what was spent, not a gauge.
  usage: (
    <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
      <rect
        x="3"
        y="2.5"
        width="10"
        height="11"
        rx="1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M5.6 6h4.8M5.6 8.5h4.8M5.6 11h2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  ),
  /*
   * A layered card: a plan is a set of tiers stacked on top of one another, and
   * not a price tag - there is still no checkout to put a price on.
   */
  plan: (
    <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
      <path
        d="M2.2 5.4 8 2.6l5.8 2.8L8 8.2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M2.2 8.4 8 11.2l5.8-2.8M2.2 11.2 8 14l5.8-2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  operations: (
    <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
      <rect
        x="2"
        y="2.5"
        width="12"
        height="2.4"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="2"
        y="6.8"
        width="7.5"
        height="2.4"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="2"
        y="11.1"
        width="9.5"
        height="2.4"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
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
  // Expanded by default so nothing is hidden on first sight. The person can fold
  // it away, but a page inside it is never hidden while it is the current page.
  const [foldedByUser, setFoldedByUser] = useState(false);
  const everyday = ROUTES.filter((route) => !isAiWorkspaceRoute(route.id));
  const aiTools = AI_WORKSPACE_IDS.flatMap((id) => ROUTES.find((route) => route.id === id) ?? []);
  const aiActive = aiTools.some((route) => route.id === activeRouteId);
  // When the sidebar is narrowed to icons there is no room for a header, so the
  // group is shown flat rather than hidden.
  const aiOpen = collapsed || !foldedByUser || aiActive;

  const link = (route: RouteDef) => {
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
  };

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
          <a className="v-sidebar__brand" href="#/chat" onClick={onMobileClose}>
            <BrandMark size={collapsed ? 36 : 38} decorative />
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

        <ul className="v-sidebar__nav">{everyday.map(link)}</ul>

        <div className="v-sidebar__group" role="group" aria-label={AI_WORKSPACE_LABEL}>
          {!collapsed && (
            <button
              type="button"
              className="v-sidebar__group-toggle"
              aria-expanded={aiOpen}
              aria-controls="v-sidebar-ai-tools"
              // A current page inside the group keeps it open, so the control
              // is inert then rather than pretending it can fold it away.
              disabled={aiActive}
              onClick={() => setFoldedByUser((folded) => !folded)}
            >
              <span>{AI_WORKSPACE_LABEL}</span>
              <svg viewBox="0 0 16 16" className="v-icon v-sidebar__chevron" aria-hidden="true">
                <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
          )}
          <ul
            id="v-sidebar-ai-tools"
            className="v-sidebar__nav v-sidebar__nav--group"
            hidden={!aiOpen}
          >
            {aiTools.map(link)}
          </ul>
        </div>

        <div className="v-sidebar__footer">
          {!collapsed && <span className="v-caption">Platform preview — under development</span>}
        </div>
      </nav>
    </>
  );
}
