import { useEffect, useRef, useState, type ReactNode } from 'react';
import { UserAvatar } from '../pages/chat/UserAvatar';
import { useAgentProfile } from '../agent/AgentProfileProvider';
import { ProfileDialog } from './ProfileDialog';
import { AI_WORKSPACE_IDS, AI_WORKSPACE_LABEL, ROUTES, type RouteDef } from './useHashRoute';

/**
 * The phone's navigation drawer.
 *
 * Laid out from a screen recording of a reference drawer, measured at its own
 * scale (1080px wide capture, 2.62 px per dp):
 *   - panel is 80% of the screen (863px, 329dp), scrim 51% black;
 *   - rows are 52dp apart with a 24dp outline icon, a 17dp label and a 20dp gap;
 *   - a quiet group label sits between the two lists;
 *   - a floating pill at the bottom-left starts a new chat, a profile circle sits
 *     at the bottom-right.
 * The wording, the icons and the groups are Veltravia's own.
 *
 * It lists the same routes the desktop sidebar lists. Nothing here is invented:
 * a feature the app does not have does not get a row.
 */

/** The everyday places, in the order a person reaches for them. */
const MAIN_IDS = ['chat', 'projects', 'builder', 'files', 'dashboard'] as const;
/** Everything else the platform offers, grouped under one label. */
const ACCOUNT_LABEL = 'Account';

const glyph = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" className="v-mmenu__icon" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </g>
  </svg>
);

const ICONS: Record<string, ReactNode> = {
  chat: glyph(
    <path d="M4 11.2C4 7.8 7.1 5 11 5h2c3.9 0 7 2.8 7 6.2s-3.1 6.2-7 6.2h-1.6L7 20v-3.6C5.2 15.3 4 13.4 4 11.2Z" />,
  ),
  projects: glyph(
    <>
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.2h7a2 2 0 0 1 2 2V17.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
    </>,
  ),
  builder: glyph(
    <>
      <path d="m9 8-4 4 4 4M15 8l4 4-4 4M13.2 6.5l-2.4 11" />
    </>,
  ),
  files: glyph(
    <>
      <path d="M6 3.5h7l5 5v12H6Z" />
      <path d="M13 3.5v5h5M9 13h6M9 16.5h4" />
    </>,
  ),
  dashboard: glyph(
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.4" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4" />
    </>,
  ),
  integrations: glyph(
    <>
      <path d="M9 4v4M15 4v4M7 8h10v3.5a5 5 0 0 1-10 0Z" />
      <path d="M12 16.5V20" />
    </>,
  ),
  audio: glyph(<path d="M5 10v4M9 6.5v11M13 8.5v7M17 10.5v3M20 11.5v1" />),
  video: glyph(
    <>
      <rect x="3.5" y="6" width="12" height="12" rx="2" />
      <path d="m15.5 10.5 5-3v9l-5-3" />
    </>,
  ),
  image: glyph(
    <>
      <rect x="4" y="4.5" width="16" height="15" rx="2" />
      <path d="m4.5 16 4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5" />
      <circle cx="9" cy="9.2" r="1.3" />
    </>,
  ),
  documents: glyph(
    <>
      <path d="M7 3.5h7l4 4V20.5H7Z" />
      <path d="M14 3.5v4h4M10 12h5M10 15.5h5" />
    </>,
  ),
  connections: glyph(
    <>
      <circle cx="7" cy="12" r="2.6" />
      <circle cx="17" cy="7" r="2.6" />
      <circle cx="17" cy="17" r="2.6" />
      <path d="m9.3 10.8 5.4-2.6M9.3 13.2l5.4 2.6" />
    </>,
  ),
  intelligence: glyph(
    <>
      <path d="M12 3.5a6.5 6.5 0 0 0-3.6 11.9c.7.6 1.1 1.3 1.1 2.1h5c0-.8.4-1.5 1.1-2.1A6.5 6.5 0 0 0 12 3.5Z" />
      <path d="M10 20.5h4" />
    </>,
  ),
  reasoning: glyph(
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5v5l3 2" />
    </>,
  ),
  execute: glyph(<path d="m8 5.5 11 6.5-11 6.5Z" />),
  'ai-providers': glyph(
    <>
      <rect x="4" y="5" width="16" height="6" rx="1.8" />
      <rect x="4" y="13" width="16" height="6" rx="1.8" />
      <path d="M8 8h.01M8 16h.01" />
    </>,
  ),
  'model-routing': glyph(
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="18" cy="18" r="2.2" />
      <path d="M6 8.2v3.3a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v-.8" />
    </>,
  ),
  settings: glyph(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.5 1.5M16.5 16.5 18 18M18 6l-1.5 1.5M7.5 16.5 6 18" />
    </>,
  ),
};

const NEW_CHAT_GLYPH = glyph(
  <>
    <path d="M12 4.5H7a2.5 2.5 0 0 0-2.5 2.5v10A2.5 2.5 0 0 0 7 19.5h10a2.5 2.5 0 0 0 2.5-2.5v-5" />
    <path d="m17.6 3.9 2.5 2.5-8 8-3.2.7.7-3.2Z" />
  </>,
);

export interface MobileMenuProps {
  readonly open: boolean;
  readonly activeRouteId: string;
  readonly onNavigate: (route: RouteDef) => void;
  readonly onNewChat: () => void;
  readonly onClose: () => void;
}

export function MobileMenu({
  open,
  activeRouteId,
  onNavigate,
  onNewChat,
  onClose,
}: MobileMenuProps) {
  const profile = useAgentProfile();
  const panel = useRef<HTMLElement>(null);
  const [profileOpen, setProfileOpen] = useState(false);

  // Opening hands focus to the panel so a keyboard or screen reader lands inside
  // it, and closing is left to Escape or the scrim, as the shell already does.
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  const main = MAIN_IDS.flatMap((id) => ROUTES.find((route) => route.id === id) ?? []);
  // The AI tools, minus the two that are already pinned among the everyday
  // places above (a route is listed once, never twice).
  const aiTools = AI_WORKSPACE_IDS.filter(
    (id) => !(MAIN_IDS as readonly string[]).includes(id),
  ).flatMap((id) => ROUTES.find((route) => route.id === id) ?? []);
  // Whatever is neither everyday nor an AI tool (model routing, settings).
  const account = ROUTES.filter(
    (route) =>
      !(MAIN_IDS as readonly string[]).includes(route.id) &&
      !(AI_WORKSPACE_IDS as readonly string[]).includes(route.id),
  );

  const row = (route: RouteDef) => {
    const active = route.id === activeRouteId;
    return (
      <li key={route.id}>
        <a
          href={route.hash}
          className={active ? 'v-mmenu__row v-mmenu__row--active' : 'v-mmenu__row'}
          aria-current={active ? 'page' : undefined}
          onClick={(event) => {
            event.preventDefault();
            onNavigate(route);
            onClose();
          }}
        >
          {ICONS[route.id]}
          <span className="v-mmenu__label">{route.title}</span>
        </a>
      </li>
    );
  };

  return (
    <div className={open ? 'v-mmenu v-mmenu--open' : 'v-mmenu'} data-testid="mobile-menu">
      <div className="v-mmenu__scrim" onClick={onClose} aria-hidden="true" />
      <nav
        ref={panel}
        className="v-mmenu__panel"
        aria-label="Primary"
        aria-hidden={!open}
        tabIndex={-1}
        // A closed drawer must not be reachable by Tab or a screen reader.
        inert={!open ? true : undefined}
      >
        <ul className="v-mmenu__list">{main.map(row)}</ul>

        <p className="v-mmenu__group">{AI_WORKSPACE_LABEL}</p>
        <ul className="v-mmenu__list v-mmenu__list--scroll">{aiTools.map(row)}</ul>

        <p className="v-mmenu__group">{ACCOUNT_LABEL}</p>
        <ul className="v-mmenu__list">{account.map(row)}</ul>

        <div className="v-mmenu__dock">
          <button
            type="button"
            className="v-mmenu__new"
            onClick={() => {
              onNewChat();
              onClose();
            }}
          >
            {NEW_CHAT_GLYPH}
            <span>Chat</span>
          </button>
          {/* The names behind the circle: yours and your assistant's. Settings
              keeps its own row, so this opens the profile itself. */}
          <button
            type="button"
            className="v-mmenu__profile"
            aria-label={`Profile for ${profile.ownerName ?? 'your account'}`}
            onClick={() => {
              onClose();
              setProfileOpen(true);
            }}
          >
            <UserAvatar name={profile.ownerName} size={40} />
          </button>
        </div>
      </nav>
      <ProfileDialog open={profileOpen} onClose={() => setProfileOpen(false)} />
    </div>
  );
}
