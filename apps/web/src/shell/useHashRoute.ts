import { useCallback, useEffect, useState } from 'react';

/**
 * Minimal hash routing (#/dashboard, #/projects, #/projects/<id>,
 * #/projects/<id>/workspace, #/settings). Future steps can replace this
 * with a fuller router without touching the shell contract:
 * (route, navigate).
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

export type RouteId =
  'dashboard' | 'projects' | 'project-detail' | 'project-workspace' | 'settings';

/** The currently active route, with route parameters when present. */
export interface RouteState {
  readonly id: RouteId;
  readonly title: string;
  readonly projectId: string | null;
}

const PROJECT_ID_PATTERN = /^#\/projects\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const WORKSPACE_PATTERN = /^#\/projects\/([A-Za-z0-9][A-Za-z0-9._-]*)\/workspace$/;

function routeForHash(hash: string): RouteState {
  if (hash === '' || hash === '#' || hash === '#/dashboard') {
    return { id: 'dashboard', title: 'Dashboard', projectId: null };
  }
  if (hash === '#/projects') {
    return { id: 'projects', title: 'Projects', projectId: null };
  }
  if (hash === '#/settings') {
    return { id: 'settings', title: 'Settings', projectId: null };
  }
  const workspaceMatch = WORKSPACE_PATTERN.exec(hash);
  if (workspaceMatch !== null) {
    return {
      id: 'project-workspace',
      title: 'Workspace',
      projectId: workspaceMatch[1] ?? null,
    };
  }
  const projectMatch = PROJECT_ID_PATTERN.exec(hash);
  if (projectMatch !== null) {
    return {
      id: 'project-detail',
      title: 'Project details',
      projectId: projectMatch[1] ?? null,
    };
  }
  return { id: 'dashboard', title: 'Dashboard', projectId: null };
}

export function useHashRoute() {
  const [route, setRoute] = useState<RouteState>(() => routeForHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(routeForHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  /** Navigates to any supported hash, updating state immediately. */
  const navigateTo = useCallback((hash: string) => {
    setRoute(routeForHash(hash));
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
  }, []);

  /** Navigates to a registered route (sidebar navigation). */
  const navigate = useCallback(
    (next: RouteDef) => {
      navigateTo(next.hash);
    },
    [navigateTo],
  );

  return { route, navigate, navigateTo };
}

/**
 * Navigates from anywhere in the app. The hash change re-syncs the shell's
 * route state through its `hashchange` listener.
 */
export function navigateToHash(hash: string): void {
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
}
