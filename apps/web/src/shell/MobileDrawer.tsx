import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BrandMark } from '../components/brand/BrandMark';
import { UserAvatar } from '../pages/chat/UserAvatar';
import { useAgentProfile } from '../agent/AgentProfileProvider';
import {
  CONVERSATIONS_CHANGED_EVENT,
  RECENT_LIMIT,
  archiveConversation,
  deleteConversation,
  listConversations,
  renameConversation,
  restoreConversation,
  type ConversationRecord,
} from '../pages/chat/conversations';
import { ROUTES, type RouteDef } from './useHashRoute';

/**
 * The website's navigation drawer.
 *
 * Laid out from a capture of the reference drawer, measured rather than eyeballed
 * (411dp phone): the panel covers 83% of the width (343dp), rows sit 47dp apart
 * with their labels 47dp in from the left edge, and the row menu is a white card
 * about 203 x 120dp with 32dp rows and 8dp corners, right-aligned under the
 * three dots it belongs to.
 *
 * Three zones, as the recording shows: a pinned head and the two ways into a new
 * conversation, one scrolling middle holding the destinations and the saved
 * conversations, and a pinned footer with the workspace. The packaged app keeps
 * its own menu (see MobileMenu); this one is only built for the browser.
 *
 * Two departures from the reference, both deliberate: there is no back arrow in
 * the head, and no upgrade card, because Veltravia has no paid plan yet. Every
 * row, menu item and footer leads somewhere real.
 */

/** The everyday destinations, in the order the desktop sidebar lists them. */
const PRIMARY_IDS = ['chat', 'projects', 'builder', 'files', 'dashboard'] as const;

const glyph = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" className="v-drawer__icon" aria-hidden="true">
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
    <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.2h7a2 2 0 0 1 2 2V17.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />,
  ),
  builder: glyph(<path d="m9 8-4 4 4 4M15 8l4 4-4 4M13.2 6.5l-2.4 11" />),
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
  connections: glyph(
    <>
      <circle cx="7" cy="12" r="2.6" />
      <circle cx="17" cy="7" r="2.6" />
      <circle cx="17" cy="17" r="2.6" />
      <path d="m9.3 10.8 5.4-2.6M9.3 13.2l5.4 2.6" />
    </>,
  ),
  documents: glyph(
    <>
      <path d="M7 3.5h7l4 4V20.5H7Z" />
      <path d="M14 3.5v4h4M10 12h5M10 15.5h5" />
    </>,
  ),
  image: glyph(
    <>
      <rect x="4" y="4.5" width="16" height="15" rx="2" />
      <path d="m4.5 16 4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5" />
      <circle cx="9" cy="9.2" r="1.3" />
    </>,
  ),
  video: glyph(
    <>
      <rect x="3.5" y="6" width="12" height="12" rx="2" />
      <path d="m15.5 10.5 5-3v9l-5-3" />
    </>,
  ),
  audio: glyph(<path d="M5 10v4M9 6.5v11M13 8.5v7M17 10.5v3M20 11.5v1" />),
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
  integrations: glyph(
    <>
      <path d="M9 4v4M15 4v4M7 8h10v3.5a5 5 0 0 1-10 0Z" />
      <path d="M12 16.5V20" />
    </>,
  ),
  operations: glyph(
    <>
      <path d="M4 18V9M9.5 18V5M15 18v-6M20.5 18v-9" />
    </>,
  ),
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

const CLOSE_GLYPH = glyph(<path d="m6 6 12 12M18 6 6 18" />);
const PLUS_GLYPH = glyph(<path d="M12 5.5v13M5.5 12h13" />);
const GEAR_GLYPH = glyph(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.5 1.5M16.5 16.5 18 18M18 6l-1.5 1.5M7.5 16.5 6 18" />
  </>,
);
const FILTER_GLYPH = glyph(<path d="M4 6.5h16M7 12h10M10 17.5h4" />);
const DOTS_GLYPH = (
  <svg viewBox="0 0 24 24" className="v-drawer__icon" aria-hidden="true" fill="currentColor">
    <circle cx="12" cy="5.5" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="12" cy="18.5" r="1.6" />
  </svg>
);

export interface MobileDrawerProps {
  readonly open: boolean;
  readonly activeRouteId: string;
  readonly onNavigate: (route: RouteDef) => void;
  readonly onNewChat: () => void;
  readonly onOpenConversation: (id: string) => void;
  readonly onClose: () => void;
}

const routeById = (id: string): RouteDef | null => ROUTES.find((route) => route.id === id) ?? null;

/** The destinations a person reaches for daily, resolved from the one route list. */
const primaryRoutes = PRIMARY_IDS.flatMap((id) => routeById(id) ?? []);

type MenuState =
  | { readonly kind: 'none' }
  | { readonly kind: 'chat'; readonly id: string }
  | { readonly kind: 'delete'; readonly id: string };

export function MobileDrawer({
  open,
  activeRouteId,
  onNavigate,
  onNewChat,
  onOpenConversation,
  onClose,
}: MobileDrawerProps) {
  const profile = useAgentProfile();
  const panel = useRef<HTMLElement>(null);
  const [conversations, setConversations] = useState<readonly ConversationRecord[]>(() =>
    listConversations(),
  );
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState<MenuState>({ kind: 'none' });
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  // Opening hands focus to the panel so a keyboard or screen reader lands inside
  // it; closing is left to Escape or the scrim, as the shell already does.
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  // A closed drawer starts clean: nothing half-open waits for the next visit.
  useEffect(() => {
    if (!open) {
      setMenu({ kind: 'none' });
      setRenaming(null);
      setExpanded(false);
    }
  }, [open]);

  // The list is storage's, so it is re-read whenever storage says it changed
  // (a rename here, a thread saved by the chat page, another tab).
  useEffect(() => {
    const refresh = () => setConversations(listConversations({ includeArchived: true }));
    refresh();
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, refresh);
  }, []);

  const visible = conversations.filter((record) => showArchived || !record.archived);
  const shown = expanded ? visible : visible.slice(0, RECENT_LIMIT);
  const more = visible.length > RECENT_LIMIT;

  const go = (route: RouteDef) => {
    onNavigate(route);
    onClose();
  };

  const row = (route: RouteDef) => {
    const active = route.id === activeRouteId;
    return (
      <li key={route.id}>
        <a
          href={route.hash}
          className={active ? 'v-drawer__row v-drawer__row--active' : 'v-drawer__row'}
          aria-current={active ? 'page' : undefined}
          onClick={(event) => {
            event.preventDefault();
            go(route);
          }}
        >
          {ICONS[route.id] ?? ICONS.settings}
          <span className="v-drawer__label">{route.title}</span>
        </a>
      </li>
    );
  };

  const startConversation = () => {
    onNewChat();
    onClose();
  };

  const openChat = (record: ConversationRecord) => {
    setMenu({ kind: 'none' });
    onOpenConversation(record.id);
    onClose();
  };

  const commitRename = () => {
    if (renaming === null) return;
    renameConversation(renaming.id, renaming.value);
    setRenaming(null);
    setMenu({ kind: 'none' });
  };

  const conversationRow = (record: ConversationRecord) => {
    const menuOpen = menu.kind === 'chat' && menu.id === record.id;
    const confirming = menu.kind === 'delete' && menu.id === record.id;
    const isRenaming = renaming?.id === record.id;
    return (
      <li key={record.id} className="v-drawer__chat">
        {isRenaming ? (
          <form
            className="v-drawer__rename"
            onSubmit={(event) => {
              event.preventDefault();
              commitRename();
            }}
          >
            <input
              className="v-drawer__rename-input"
              aria-label="Conversation name"
              value={renaming.value}
              autoFocus
              onChange={(event) => setRenaming({ id: record.id, value: event.currentTarget.value })}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setRenaming(null);
                }
              }}
            />
            <button type="submit" className="v-drawer__rename-save">
              Save
            </button>
          </form>
        ) : (
          <>
            <button type="button" className="v-drawer__chat-open" onClick={() => openChat(record)}>
              <span className="v-drawer__chat-dot" aria-hidden="true" />
              <span className="v-drawer__chat-title">{record.title}</span>
              {record.archived ? <span className="v-drawer__chat-tag">Archived</span> : null}
            </button>
            <button
              type="button"
              className="v-drawer__chat-menu"
              aria-label={`Actions for ${record.title}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen || confirming}
              onClick={() => setMenu(menuOpen ? { kind: 'none' } : { kind: 'chat', id: record.id })}
            >
              {DOTS_GLYPH}
            </button>
          </>
        )}

        {menuOpen || confirming ? (
          <div className="v-drawer__card v-drawer__card--chat" role="menu">
            {confirming ? (
              <>
                <p className="v-drawer__card-note">Delete this conversation?</p>
                <button
                  type="button"
                  role="menuitem"
                  className="v-drawer__card-item v-drawer__card-item--danger"
                  onClick={() => {
                    deleteConversation(record.id);
                    setMenu({ kind: 'none' });
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="v-drawer__card-item"
                  onClick={() => setMenu({ kind: 'none' })}
                >
                  Keep it
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="v-drawer__card-item"
                  onClick={() => setRenaming({ id: record.id, value: record.title })}
                >
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="v-drawer__card-item"
                  onClick={() => {
                    if (record.archived) restoreConversation(record.id);
                    else archiveConversation(record.id);
                    setMenu({ kind: 'none' });
                  }}
                >
                  {record.archived ? 'Restore' : 'Archive'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="v-drawer__card-item v-drawer__card-item--danger"
                  onClick={() => setMenu({ kind: 'delete', id: record.id })}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        ) : null}
      </li>
    );
  };

  const ownerName = profile.ownerName;
  const workspaceName =
    ownerName === null || ownerName.trim() === ''
      ? 'Personal workspace'
      : `${ownerName.trim().split(/\s+/)[0]}'s workspace`;

  return (
    <div className={open ? 'v-drawer v-drawer--open' : 'v-drawer'} data-testid="mobile-drawer">
      <div className="v-drawer__scrim" onClick={onClose} aria-hidden="true" />
      <nav
        ref={panel}
        className="v-drawer__panel"
        aria-label="Primary"
        aria-hidden={!open}
        tabIndex={-1}
        // A closed drawer must not be reachable by Tab or a screen reader.
        inert={!open ? true : undefined}
      >
        <header className="v-drawer__head">
          <BrandMark size={26} decorative />
          <button
            type="button"
            className="v-drawer__close"
            aria-label="Close navigation"
            onClick={onClose}
          >
            {CLOSE_GLYPH}
          </button>
        </header>

        <div className="v-drawer__pinned">
          <a
            className="v-drawer__agent"
            href="#/settings"
            onClick={(event) => {
              event.preventDefault();
              const settings = routeById('settings');
              if (settings !== null) go(settings);
            }}
          >
            <span className="v-drawer__agent-icon">{GEAR_GLYPH}</span>
            <span className="v-drawer__agent-name">{profile.agentName}</span>
          </a>
          <button type="button" className="v-drawer__new" onClick={startConversation}>
            <span className="v-drawer__new-icon">{PLUS_GLYPH}</span>
            <span>New conversation</span>
          </button>
        </div>

        <div className="v-drawer__scroll">
          <ul className="v-drawer__list">{primaryRoutes.map(row)}</ul>

          <section className="v-drawer__chats" aria-label="Conversations">
            <div className="v-drawer__chats-head">
              <h2 className="v-drawer__chats-title">Conversations</h2>
              <button
                type="button"
                className="v-drawer__chats-action"
                aria-pressed={showArchived}
                aria-label={
                  showArchived ? 'Hide archived conversations' : 'Show archived conversations'
                }
                onClick={() => setShowArchived((value) => !value)}
              >
                {FILTER_GLYPH}
              </button>
              <button
                type="button"
                className="v-drawer__chats-action"
                aria-label="Start a conversation"
                onClick={startConversation}
              >
                {PLUS_GLYPH}
              </button>
            </div>

            {shown.length === 0 ? (
              <p className="v-drawer__chats-empty">
                {showArchived
                  ? 'Nothing archived yet.'
                  : 'No conversations yet. What you ask here is kept on this device.'}
              </p>
            ) : (
              <ul className="v-drawer__chat-list">
                {shown.map((record) => conversationRow(record))}
              </ul>
            )}

            {more ? (
              <button
                type="button"
                className="v-drawer__see-all"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? 'Show less' : 'See all…'}
              </button>
            ) : null}
          </section>
        </div>

        <footer className="v-drawer__foot">
          <a
            className="v-drawer__workspace"
            href="#/settings"
            aria-label={`Settings for ${workspaceName}`}
            onClick={(event) => {
              event.preventDefault();
              const settings = routeById('settings');
              if (settings !== null) go(settings);
            }}
          >
            <UserAvatar name={ownerName} size={34} />
            <span className="v-drawer__workspace-text">
              <span className="v-drawer__workspace-name">{workspaceName}</span>
              <span className="v-drawer__workspace-owner">{ownerName ?? 'Not signed in'}</span>
            </span>
          </a>
        </footer>
      </nav>
    </div>
  );
}
