// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Sidebar } from './Sidebar';
import { AI_WORKSPACE_IDS, ROUTES, isAiWorkspaceRoute } from './useHashRoute';

afterEach(cleanup);

function setup(activeRouteId = 'chat', collapsed = false) {
  return render(
    <Sidebar
      activeRouteId={activeRouteId}
      onNavigate={() => undefined}
      collapsed={collapsed}
      onToggleCollapse={() => undefined}
      mobileOpen={false}
      onMobileClose={() => undefined}
    />,
  );
}

const group = () => screen.getByRole('group', { name: 'AI workspace' });

describe('the AI workspace group in the sidebar', () => {
  it('names only real routes, once each', () => {
    const known = new Set(ROUTES.map((route) => route.id));
    for (const id of AI_WORKSPACE_IDS) expect(known.has(id)).toBe(true);
    expect(new Set(AI_WORKSPACE_IDS).size).toBe(AI_WORKSPACE_IDS.length);
    expect(AI_WORKSPACE_IDS).toHaveLength(12);
  });

  it('holds all twelve AI tools and nothing else', () => {
    setup();
    const labels = within(group())
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(labels).toEqual([
      'Reasoning workspace',
      'Model runs',
      'Knowledge synthesis',
      'Connected Apps',
      'Document intelligence',
      'Image intelligence',
      'Video intelligence',
      'Audio intelligence',
      'Integrations',
      'AI providers',
      'App Builder',
      'Files & artifacts',
    ]);
  });

  it('keeps the everyday places outside the group', () => {
    setup();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    for (const name of ['Chat', 'Dashboard', 'Projects', 'Model routing', 'Settings']) {
      const link = within(nav).getByRole('link', { name: new RegExp(`^${name}`) });
      expect(group().contains(link)).toBe(false);
    }
  });

  it('shows every route exactly once across the whole sidebar', () => {
    setup();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const links = within(nav)
      .getAllByRole('link')
      .filter(
        (link) => link.getAttribute('href')?.startsWith('#/') && link.className.includes('link'),
      );
    expect(links).toHaveLength(ROUTES.length);
    expect(new Set(links.map((l) => l.getAttribute('href'))).size).toBe(ROUTES.length);
  });

  it('starts open, so no tool is hidden on first sight', () => {
    setup();
    const toggle = screen.getByRole('button', { name: /AI workspace/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: /Model runs/ })).toBeDefined();
  });

  it('folds away and opens again', () => {
    setup();
    const toggle = screen.getByRole('button', { name: /AI workspace/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: /Model runs/ })).toBeNull();
    // The everyday places stay reachable while it is folded.
    expect(screen.getByRole('link', { name: /^Projects/ })).toBeDefined();
    fireEvent.click(toggle);
    expect(screen.getByRole('link', { name: /Model runs/ })).toBeDefined();
  });

  it('cannot hide the page you are on', () => {
    setup('execute');
    const toggle = screen.getByRole('button', { name: /AI workspace/ }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    const current = screen.getByRole('link', { name: /Model runs/ });
    expect(current.getAttribute('aria-current')).toBe('page');
  });

  it('opens by itself when you arrive at a tool that was folded', () => {
    const view = setup('chat');
    fireEvent.click(screen.getByRole('button', { name: /AI workspace/ }));
    expect(screen.queryByRole('link', { name: /Model runs/ })).toBeNull();
    view.rerender(
      <Sidebar
        activeRouteId="execute"
        onNavigate={() => undefined}
        collapsed={false}
        onToggleCollapse={() => undefined}
        mobileOpen={false}
        onMobileClose={() => undefined}
      />,
    );
    expect(screen.getByRole('link', { name: /Model runs/ })).toBeDefined();
  });

  it('does not hide the tools when the sidebar is narrowed to icons', () => {
    // Fold the group while the sidebar is wide, THEN narrow it: the icon-only
    // sidebar has no header to unfold with, so it must show the tools anyway.
    const view = setup('chat', false);
    fireEvent.click(screen.getByRole('button', { name: /AI workspace/ }));
    expect(screen.queryByRole('link', { name: /Model runs/ })).toBeNull();
    view.rerender(
      <Sidebar
        activeRouteId="chat"
        onNavigate={() => undefined}
        collapsed
        onToggleCollapse={() => undefined}
        mobileOpen={false}
        onMobileClose={() => undefined}
      />,
    );
    expect(screen.queryByRole('button', { name: /AI workspace/ })).toBeNull();
    expect(within(group()).getAllByRole('link')).toHaveLength(12);
    expect(within(group()).getByTitle('Model runs')).toBeDefined();
  });

  it('tells apart AI tools from everything else', () => {
    expect(isAiWorkspaceRoute('reasoning')).toBe(true);
    expect(isAiWorkspaceRoute('builder')).toBe(true);
    expect(isAiWorkspaceRoute('settings')).toBe(false);
    expect(isAiWorkspaceRoute('model-routing')).toBe(false);
    expect(isAiWorkspaceRoute('nope')).toBe(false);
  });
});
