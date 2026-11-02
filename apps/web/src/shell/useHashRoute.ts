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
  { id: 'chat', hash: '#/chat', title: 'Chat' },
  { id: 'dashboard', hash: '#/dashboard', title: 'Dashboard' },
  { id: 'projects', hash: '#/projects', title: 'Projects' },
  { id: 'integrations', hash: '#/integrations', title: 'Integrations' },
  { id: 'files', hash: '#/files', title: 'Files & artifacts' },
  { id: 'audio', hash: '#/audio', title: 'Audio intelligence' },
  { id: 'video', hash: '#/video', title: 'Video intelligence' },
  { id: 'image', hash: '#/image', title: 'Image intelligence' },
  { id: 'documents', hash: '#/documents', title: 'Document intelligence' },
  { id: 'connections', hash: '#/connections', title: 'Connected Apps' },
  { id: 'intelligence', hash: '#/intelligence', title: 'Knowledge synthesis' },
  { id: 'reasoning', hash: '#/reasoning', title: 'Reasoning workspace' },
  { id: 'execute', hash: '#/execute', title: 'Model runs' },
  { id: 'ai-providers', hash: '#/settings/ai-providers', title: 'AI providers' },
  { id: 'model-routing', hash: '#/settings/models', title: 'Model routing' },
  { id: 'builder', hash: '#/builder', title: 'App Builder' },
  { id: 'settings', hash: '#/settings', title: 'Settings' },
] as const;

export type RouteId =
  | 'chat'
  | 'dashboard'
  | 'projects'
  | 'integrations'
  | 'files'
  | 'audio'
  | 'image'
  | 'video'
  | 'documents'
  | 'connections'
  | 'intelligence'
  | 'reasoning'
  | 'execute'
  | 'project-detail'
  | 'project-workspace'
  | 'project-builder'
  | 'project-backend'
  | 'project-app'
  | 'ai-providers'
  | 'model-routing'
  | 'builder'
  | 'settings';

/** The currently active route, with route parameters when present. */
export interface RouteState {
  readonly id: RouteId;
  readonly title: string;
  readonly projectId: string | null;
}

const PROJECT_ID_PATTERN = /^#\/projects\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const WORKSPACE_PATTERN = /^#\/projects\/([A-Za-z0-9][A-Za-z0-9._-]*)\/workspace$/;
const BUILDER_PATTERN = /^#\/projects\/([A-Za-z0-9][A-Za-z0-9._-]*)\/builder$/;
const BACKEND_PATTERN = /^#\/projects\/([A-Za-z0-9][A-Za-z0-9._-]*)\/backend$/;
const APP_PATTERN = /^#\/projects\/([A-Za-z0-9][A-Za-z0-9._-]*)\/app$/;

function routeForHash(hash: string): RouteState {
  // The assistant is the front door: an empty hash lands on the chat.
  if (hash === '' || hash === '#' || hash === '#/chat') {
    return { id: 'chat', title: 'Chat', projectId: null };
  }
  if (hash === '#/dashboard') {
    return { id: 'dashboard', title: 'Dashboard', projectId: null };
  }
  if (hash === '#/projects') {
    return { id: 'projects', title: 'Projects', projectId: null };
  }
  if (hash === '#/integrations') {
    return { id: 'integrations', title: 'Integrations', projectId: null };
  }
  if (hash === '#/files') {
    return { id: 'files', title: 'Files & artifacts', projectId: null };
  }
  if (hash === '#/audio') {
    return { id: 'audio', title: 'Audio intelligence', projectId: null };
  }
  if (hash === '#/video') return { id: 'video', title: 'Video intelligence', projectId: null };
  if (hash === '#/image') {
    return { id: 'image', title: 'Image intelligence', projectId: null };
  }
  if (hash === '#/documents') {
    return { id: 'documents', title: 'Document intelligence', projectId: null };
  }
  if (hash === '#/connections') {
    return { id: 'connections', title: 'Connected Apps', projectId: null };
  }
  if (hash === '#/intelligence') {
    return { id: 'intelligence', title: 'Knowledge synthesis', projectId: null };
  }
  if (hash === '#/builder') {
    return { id: 'builder', title: 'App Builder', projectId: null };
  }
  if (hash === '#/reasoning') {
    return { id: 'reasoning', title: 'Reasoning workspace', projectId: null };
  }
  if (hash === '#/execute') {
    return { id: 'execute', title: 'Model runs', projectId: null };
  }
  if (hash === '#/settings/ai-providers') {
    return { id: 'ai-providers', title: 'AI providers', projectId: null };
  }
  if (hash === '#/settings/models') {
    return { id: 'model-routing', title: 'Model routing', projectId: null };
  }
  if (hash === '#/settings') {
    return { id: 'settings', title: 'Settings', projectId: null };
  }
  const appMatch = APP_PATTERN.exec(hash);
  if (appMatch !== null) {
    return {
      id: 'project-app',
      title: 'Application workspace',
      projectId: appMatch[1] ?? null,
    };
  }
  const builderMatch = BUILDER_PATTERN.exec(hash);
  if (builderMatch !== null) {
    return {
      id: 'project-builder',
      title: 'Frontend builder',
      projectId: builderMatch[1] ?? null,
    };
  }
  const backendMatch = BACKEND_PATTERN.exec(hash);
  if (backendMatch !== null) {
    return {
      id: 'project-backend',
      title: 'Backend builder',
      projectId: backendMatch[1] ?? null,
    };
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
  return { id: 'chat', title: 'Chat', projectId: null };
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
