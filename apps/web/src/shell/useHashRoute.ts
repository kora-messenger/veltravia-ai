import { useCallback, useEffect, useState } from 'react';

/**
 * Minimal hash routing (#/dashboard). Future steps can replace this with a
 * fuller router without touching the shell contract: (route, navigate).
 */

export interface RouteDef {
  id: string;
  hash: string;
  title: string;
}

export const ROUTES: readonly RouteDef[] = [
  { id: 'dashboard', hash: '#/dashboard', title: 'Dashboard' },
  { id: 'projects', hash: '#/projects', title: 'Projects' },
  { id: 'settings', hash: '#/settings', title: 'Settings' },
] as const;

const DEFAULT_ROUTE: RouteDef = ROUTES[0] ?? {
  id: 'dashboard',
  hash: '#/dashboard',
  title: 'Dashboard',
};

function routeForHash(hash: string): RouteDef {
  const normalized = hash === '' || hash === '#' ? '' : hash;
  return ROUTES.find((route) => route.hash === normalized) ?? DEFAULT_ROUTE;
}

export function useHashRoute() {
  const [route, setRoute] = useState<RouteDef>(() => routeForHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(routeForHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next: RouteDef) => {
    setRoute(next);
    if (window.location.hash !== next.hash) {
      window.location.hash = next.hash;
    }
  }, []);

  return { route, navigate };
}
