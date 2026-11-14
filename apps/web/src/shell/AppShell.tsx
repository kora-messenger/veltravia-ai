import { useEffect, useState, type ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { MobileMenu } from './MobileMenu';
import { MobileDrawer } from './MobileDrawer';
import { isPackagedApp } from '../config/runtime-config';
import { requestOpenConversation } from '../pages/chat/conversations';
import { NEW_CHAT_EVENT } from '../pages/chat/useChatSession';
import { TopBar } from './TopBar';
import { BackendNotice } from '../components/BackendNotice';
import { OfflineBanner } from '../components/OfflineBanner';
import { useHashRoute, type RouteState } from './useHashRoute';
import { useWideLayout } from './use-wide-layout';

export interface AppShellProps {
  /** Route content. Receives the full route state, including parameters. */
  renderPage(route: RouteState): ReactNode;
}

/**
 * The primary application shell: persistent sidebar navigation + top bar +
 * main content area, with a deliberate mobile layout (drawer navigation).
 */
export function AppShell({ renderPage }: AppShellProps) {
  const { route, navigate } = useHashRoute();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // The website has two menus on purpose: the phone keeps its own drawer, and only
  // a wide screen gets the desk-shaped panel, standing as the page's own column.
  const wide = useWideLayout();
  const packaged = isPackagedApp();
  const docked = wide && !packaged;

  // Close the drawer on Escape.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  // Starting a chat from anywhere lands on the chat first, then clears it.
  const startNewChat = () => {
    navigate({ id: 'chat', hash: '#/chat', title: 'Chat' });
    window.setTimeout(() => window.dispatchEvent(new Event(NEW_CHAT_EVENT)), 0);
  };

  // The project routes highlight the Projects navigation item.
  const activeNavId =
    route.id === 'project-detail' || route.id === 'project-workspace' ? 'projects' : route.id;

  // The workspace is a full-bleed, three-panel surface: it manages its own
  // padding and scrolling, so the shell content area steps aside.
  const contentClassName =
    route.id === 'project-workspace' || route.id === 'chat'
      ? 'v-shell__content v-shell__content--flush'
      : 'v-shell__content';

  return (
    <div className="v-shell">
      {packaged ? (
        <Sidebar
          activeRouteId={activeNavId}
          onNavigate={navigate}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((value) => !value)}
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
        />
      ) : null}
      {/* The phone's menu, on the website and in the packaged app alike. */}
      {packaged || !wide ? (
        <MobileMenu
          open={mobileOpen}
          activeRouteId={activeNavId}
          onNavigate={(next) => {
            navigate(next);
          }}
          onNewChat={startNewChat}
          onClose={() => setMobileOpen(false)}
        />
      ) : null}
      {/* The wide screen's menu: the desk panel, docked as the page's column. It
          is not a phone surface, so a narrow window never mounts it. */}
      {docked ? (
        <MobileDrawer
          open
          docked
          activeRouteId={activeNavId}
          onNavigate={(next) => {
            navigate(next);
          }}
          onNewChat={startNewChat}
          onOpenConversation={(id) => {
            // Land on the chat first, then hand it the thread: the page that
            // shows a conversation only exists once the route has changed.
            navigate({ id: 'chat', hash: '#/chat', title: 'Chat' });
            window.setTimeout(() => requestOpenConversation(id), 0);
          }}
          onClose={() => setMobileOpen(false)}
        />
      ) : null}
      <div className="v-shell__main">
        <BackendNotice />
        <OfflineBanner />
        <TopBar
          route={route}
          showMenuButton={!docked}
          onOpenMobileNav={() => setMobileOpen(true)}
        />
        <main className={contentClassName} id="main-content">
          {renderPage(route)}
        </main>
      </div>
    </div>
  );
}
