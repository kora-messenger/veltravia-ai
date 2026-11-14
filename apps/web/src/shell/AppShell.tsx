import { useEffect, useState, type ReactNode } from 'react';
import { Sidebar } from './Sidebar';
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
  // One navigation surface, in two frames: a drawer over the page on a phone, the
  // page's own column on a wide screen. Same list, same rows, same size.
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
      {/* The one menu: docked as the column on a wide screen, slid over the page
          on a phone. The phone draws the same panel, the same rows and the same
          footer, at the same 300dp; only the frame changes. */}
      <MobileDrawer
        open={docked || mobileOpen}
        docked={docked}
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
