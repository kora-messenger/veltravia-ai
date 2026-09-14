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

  // The project-detail route highlights the Projects navigation item.
  const activeNavId = route.id === 'project-detail' ? 'projects' : route.id;

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
        <main className="v-shell__content" id="main-content">
          {renderPage(route)}
        </main>
      </div>
    </div>
  );
}
