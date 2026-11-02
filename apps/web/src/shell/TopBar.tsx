import { useState, type ReactNode } from 'react';
import { Dialog, Menu, type MenuItemDef } from '../components/ui';
import { BrandMark } from '../components/brand/BrandMark';
import { useTheme, type ThemePreference } from '../theme/ThemeProvider';
import { useAgentProfile } from '../agent/AgentProfileProvider';
import { AgentNameDialog } from './AgentNameDialog';
import type { RouteState } from './useHashRoute';

export interface TopBarProps {
  route: RouteState;
  onOpenMobileNav(): void;
}

/** Small 18px glyphs for the popup rows, drawn on one 20-unit grid so the
 *  stroke weight matches the bar's own icons. */
const MenuIcon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 20 20" className="v-menu__glyph" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </g>
  </svg>
);

const THEME_GLYPH = (
  <MenuIcon>
    <circle cx="10" cy="10" r="6.6" />
    <path d="M10 3.4a6.6 6.6 0 0 0 0 13.2Z" fill="currentColor" stroke="none" />
  </MenuIcon>
);

const BELL_GLYPH = (
  <MenuIcon>
    <path d="M5.4 8.2a4.6 4.6 0 0 1 9.2 0c0 3 .9 4 1.4 4.6H4c.5-.6 1.4-1.6 1.4-4.6Z" />
    <path d="M8.4 15.4a1.7 1.7 0 0 0 3.2 0" />
  </MenuIcon>
);

const PERSON_GLYPH = (
  <MenuIcon>
    <circle cx="10" cy="6.9" r="3.1" />
    <path d="M4.2 16.4c0-2.6 2.6-4.2 5.8-4.2s5.8 1.6 5.8 4.2" />
  </MenuIcon>
);

const EXIT_GLYPH = (
  <MenuIcon>
    <path d="M11.4 3.6H5.4a1.4 1.4 0 0 0-1.4 1.4v10a1.4 1.4 0 0 0 1.4 1.4h6" />
    <path d="M13.2 6.9 16.6 10l-3.4 3.1M16.2 10H8.6" />
  </MenuIcon>
);

const THEME_LABEL: Record<ThemePreference, string> = {
  // Short enough to stay on one popup row at 390px; it still says plainly
  // that the theme follows the operating system.
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export function TopBar({ route, onOpenMobileNav }: TopBarProps) {
  const { preference, setPreference } = useTheme();
  const profile = useAgentProfile();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [nameDialogOpen, setNameDialogOpen] = useState(false);

  // The chat is a conversation with a named assistant, so the header says who
  // that is instead of repeating the route name. Every other page keeps its
  // own title.
  const showsAgentName = route.id === 'chat';

  const accountItems: MenuItemDef[] = [
    {
      id: 'theme',
      label: `Theme: ${THEME_LABEL[preference]}`,
      icon: THEME_GLYPH,
      onSelect: () => {
        const order: ThemePreference[] = ['system', 'light', 'dark'];
        const index = order.indexOf(preference);
        const next = order[(index + 1) % order.length];
        if (next !== undefined) setPreference(next);
      },
    },
    {
      id: 'notifications',
      label: 'Notifications',
      icon: BELL_GLYPH,
      onSelect: () => setNotificationsOpen(true),
    },
    {
      id: 'account',
      label: 'Account',
      icon: PERSON_GLYPH,
      onSelect: () => {
        /* Account management arrives with authentication (a later step). */
      },
      disabled: true,
    },
    {
      id: 'sign-out',
      label: 'Sign out',
      icon: EXIT_GLYPH,
      onSelect: () => {
        /* Sign-out arrives with authentication (a later step). */
      },
      disabled: true,
    },
  ];

  return (
    <header className="v-topbar" data-testid="topbar">
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
            real subscription behind it. Notifications live in the account menu. */}
        <span className="v-topbar__premium-slot" aria-hidden="true" />
        <Menu
          triggerLabel="Account menu"
          items={accountItems}
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
                  strokeWidth="1.4"
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
                  strokeWidth="1.4"
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
      <Dialog
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        title="Notifications"
      >
        <p className="v-topbar__notify-empty" role="status">
          Nothing here yet. This release has no notification source connected, so no events are
          collected or shown.
        </p>
      </Dialog>
      {showsAgentName && (
        <AgentNameDialog open={nameDialogOpen} onClose={() => setNameDialogOpen(false)} />
      )}
    </header>
  );
}
