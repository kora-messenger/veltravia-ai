import { useState, type ReactNode } from 'react';
import { Menu, type MenuItemDef } from '../components/ui';
import { BrandMark } from '../components/brand/BrandMark';
import { useAgentProfile } from '../agent/AgentProfileProvider';
import { AgentNameDialog } from './AgentNameDialog';
import type { RouteState } from './useHashRoute';

export interface TopBarProps {
  route: RouteState;
  /** Hidden when the navigation already stands open as the page's column. */
  showMenuButton?: boolean;
  onOpenMobileNav(): void;
}

/** Small 18px glyphs for the popup rows, drawn on one 20-unit grid so the
 *  stroke weight matches the bar's own icons. */
const MenuIcon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 20 20" className="v-menu__glyph" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </g>
  </svg>
);

/** A page with ruled lines: the reference's Notes row. */
const NOTES_GLYPH = (
  <MenuIcon>
    <path d="M4.6 2.9h6.6l4.2 4.2v10H4.6Z" />
    <path d="M11.2 2.9v4.2h4.2" />
    <path d="M7 10.6h6M7 13.2h6" />
  </MenuIcon>
);

/** A monitor on its stand: the reference's Computer row. */
const COMPUTER_GLYPH = (
  <MenuIcon>
    <rect x="2.4" y="4.2" width="15.2" height="9.6" rx="1.4" />
    <path d="M10 13.8v2.6M6.8 16.8h6.4" />
  </MenuIcon>
);

export function TopBar({ route, showMenuButton = true, onOpenMobileNav }: TopBarProps) {
  const profile = useAgentProfile();
  const [nameDialogOpen, setNameDialogOpen] = useState(false);

  // The chat is a conversation with a named assistant, so the header says who
  // that is instead of repeating the route name. Every other page keeps its
  // own title.
  const showsAgentName = route.id === 'chat';

  // Two rows, exactly as the reference shows them. Neither surface exists in
  // this release, so both read "Soon" and are disabled: a row that looks
  // tappable and does nothing would be worse than one that says it is not
  // ready. Drop `disabled` and add `onSelect` when the panels land.
  const overflowItems: MenuItemDef[] = [
    {
      id: 'notes',
      label: 'Notes',
      icon: NOTES_GLYPH,
      hint: 'Soon',
      disabled: true,
      onSelect: () => {
        /* The notes surface is not built yet. */
      },
    },
    {
      id: 'computer',
      label: 'Computer',
      icon: COMPUTER_GLYPH,
      hint: 'Soon',
      disabled: true,
      onSelect: () => {
        /* The computer surface is not built yet. */
      },
    },
  ];

  return (
    <header className="v-topbar" data-testid="topbar">
      {showMenuButton ? (
        <button
          type="button"
          className="v-topbar__menu-button"
          aria-label="Open navigation"
          onClick={onOpenMobileNav}
        >
          <svg viewBox="0 0 16 16" className="v-icon" aria-hidden="true">
            <path
              d="M2 4h12M2 8h12M2 12h12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : null}
      <span className="v-topbar__brand">
        <BrandMark size={22} decorative />
      </span>
      <div className="v-topbar__context">
        {showsAgentName ? (
          <button
            type="button"
            className="v-topbar__agent"
            onClick={() => setNameDialogOpen(true)}
            aria-label={`Name your agent (currently called ${profile.agentName})`}
            title="Rename your agent"
          >
            <h1 className="v-heading-2 v-topbar__title">{profile.agentName}</h1>
          </button>
        ) : (
          <h1 className="v-heading-2 v-topbar__title">{route.title}</h1>
        )}
      </div>
      <div className="v-topbar__spacer" />
      <div className="v-topbar__actions">
        {/* Reserved, empty, and never filled with a decorative mark: the slot
            the reference puts a premium crown in stays clear until there is a
            real subscription behind it. */}
        <span className="v-topbar__premium-slot" aria-hidden="true" />
        <Menu
          triggerLabel="Panel menu"
          items={overflowItems}
          trigger={
            <span className="v-topbar__account-icon">
              {/* The reference glyph: a document with three ruled lines in the
                  upper right, and a monitor standing in front of its lower-left
                  corner. The monitor is drawn over a surface-coloured copy of
                  itself so the document's corner reads as behind it instead of
                  two strokes crossing. */}
              <svg viewBox="0 0 20 20" className="v-icon" aria-hidden="true">
                <g
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="8.25" y="1.6" width="10" height="8.7" rx="1.5" />
                  <path d="M10.9 4.3h4.4M10.9 6.3h4.4M13.4 8.3h1.9" />
                </g>
                <g
                  className="v-topbar__icon-knockout"
                  fill="none"
                  strokeWidth="3.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="1.8" y="7.8" width="11" height="8" rx="1.5" />
                  <path d="M7.3 15.8v1.6M5.1 17.8h4.4" />
                </g>
                <g
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="1.8" y="7.8" width="11" height="8" rx="1.5" />
                  <path d="M7.3 15.8v1.6M5.1 17.8h4.4" />
                </g>
              </svg>
            </span>
          }
        />
      </div>
      {showsAgentName && (
        <AgentNameDialog open={nameDialogOpen} onClose={() => setNameDialogOpen(false)} />
      )}
    </header>
  );
}
