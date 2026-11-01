import { useState } from 'react';
import { Menu, type MenuItemDef } from '../components/ui';
import { BrandMark } from '../components/brand/BrandMark';
import { useTheme, type ThemePreference } from '../theme/ThemeProvider';
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
  const [notificationsOpen, setNotificationsOpen] = useState(false);

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
      <div className="v-topbar__context">
        <h1 className="v-heading-2 v-topbar__title">{route.title}</h1>
      </div>
      <div className="v-topbar__spacer" />
      <div className="v-topbar__actions">
        <div className="v-topbar__notifications">
          <button
            type="button"
            className="v-topbar__notify-button"
            aria-label="Notifications"
            aria-expanded={notificationsOpen}
            aria-controls="veltravia-notifications"
            onClick={() => setNotificationsOpen((open) => !open)}
          >
            <BrandMark variant="notification" size={24} decorative />
          </button>
          {notificationsOpen && (
            <div
              id="veltravia-notifications"
              className="v-topbar__notify-panel"
              role="dialog"
              aria-label="Notification centre"
            >
              <div className="v-topbar__notify-head">
                <BrandMark variant="notification" size={28} decorative />
                <h2 className="v-heading-3">Notifications</h2>
                <button
                  type="button"
                  className="v-topbar__notify-close"
                  onClick={() => setNotificationsOpen(false)}
                  aria-label="Close notifications"
                >
                  ×
                </button>
              </div>
              <p className="v-topbar__notify-empty" role="status">
                Nothing here yet. This release has no notification source connected, so no events
                are collected or shown.
              </p>
            </div>
          )}
        </div>
        <Menu triggerLabel="Account menu" items={accountItems} trigger={<span>Account</span>} />
      </div>
    </header>
  );
}
