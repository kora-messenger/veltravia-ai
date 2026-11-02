import { useState } from 'react';
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

const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Match system',
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
      onSelect: () => setNotificationsOpen(true),
    },
    {
      id: 'account',
      label: 'Account',
      icon: undefined,
      onSelect: () => {
        /* Account management arrives with authentication (a later step). */
      },
      disabled: true,
    },
    {
      id: 'sign-out',
      label: 'Sign out',
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
              <svg viewBox="0 0 20 20" className="v-icon" aria-hidden="true">
                <path
                  d="M6.5 2.5h5l2 2h-5l-2-2Z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
                <rect
                  x="2.75"
                  y="7.25"
                  width="14.5"
                  height="9.5"
                  rx="1.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M8 13.75h4"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
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
