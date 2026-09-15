import { useEffect, useState, type ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useHashRoute, type RouteState } from './useHashRoute';

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

  // Close the drawer on Escape.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  // The project routes highlight the Projects navigation item.
  const activeNavId =
    route.id === 'project-detail' || route.id === 'project-workspace' ? 'projects' : route.id;

  // The workspace is a full-bleed, three-panel surface: it manages its own
  // padding and scrolling, so the shell content area steps aside.
  const contentClassName =
    route.id === 'project-workspace'
      ? 'v-shell__content v-shell__content--flush'
      : 'v-shell__content';

  return (
    <div className="v-shell">
      <Sidebar
        activeRouteId={activeNavId}
        onNavigate={navigate}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((value) => !value)}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />
      <div className="v-shell__main">
        <TopBar route={route} onOpenMobileNav={() => setMobileOpen(true)} />
        <main className={contentClassName} id="main-content">
          {renderPage(route)}
        </main>
      </div>
    </div>
  );
}
