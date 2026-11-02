// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '../theme/ThemeProvider';
import { AppShell } from './AppShell';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

function renderShell() {
  return render(
    <ThemeProvider>
      <AppShell renderPage={(route) => <div data-testid={`page-${route.id}`} />} />
    </ThemeProvider>,
  );
}

describe('AppShell', () => {
  it('renders the brand, primary navigation, and top bar', () => {
    renderShell();
    expect(screen.getAllByText('Veltravia AI').length).toBeGreaterThan(0);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav).toBeDefined();
    for (const label of ['Dashboard', 'Projects', 'Settings']) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeDefined();
    }
    expect(screen.getByTestId('topbar')).toBeDefined();
  });

  it('starts on the assistant chat route', () => {
    renderShell();
    expect(screen.getByTestId('page-chat')).toBeDefined();
    // The chat header names the assistant instead of repeating the route.
    expect(screen.getByRole('heading', { name: 'My Engineer' })).toBeDefined();
  });

  it('marks the active navigation item with aria-current', () => {
    renderShell();
    const active = screen.getByRole('link', { name: /^Chat/ });
    expect(active.getAttribute('aria-current')).toBe('page');
    const inactive = screen.getByRole('link', { name: /Projects/ });
    expect(inactive.getAttribute('aria-current')).toBeNull();
  });

  it('keeps the dashboard reachable as its own route', () => {
    renderShell();
    fireEvent.click(screen.getByRole('link', { name: /Dashboard/ }));
    expect(window.location.hash).toBe('#/dashboard');
    expect(screen.getByTestId('page-dashboard')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeDefined();
  });

  it('navigates between routes and updates the hash, title, and active state', () => {
    renderShell();
    fireEvent.click(screen.getByRole('link', { name: /Projects/ }));
    expect(window.location.hash).toBe('#/projects');
    expect(screen.getByTestId('page-projects')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Projects' })).toBeDefined();
    expect(screen.getByRole('link', { name: /Projects/ }).getAttribute('aria-current')).toBe(
      'page',
    );

    fireEvent.click(screen.getByRole('link', { name: /Settings/ }));
    expect(window.location.hash).toBe('#/settings');
    expect(screen.getByTestId('page-settings')).toBeDefined();
  });

  it('responds to external hash changes', () => {
    renderShell();
    window.location.hash = '#/settings';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByTestId('page-settings')).toBeDefined();
    expect(screen.getByRole('link', { name: /Settings/ }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('routes to a project detail page and highlights the Projects nav item', () => {
    renderShell();
    window.location.hash = '#/projects/prj-42';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByTestId('page-project-detail')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Project details' })).toBeDefined();
    expect(screen.getByRole('link', { name: /Projects/ }).getAttribute('aria-current')).toBe(
      'page',
    );

    window.location.hash = '#/projects';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByTestId('page-projects')).toBeDefined();
  });

  it('routes to a project workspace and highlights the Projects nav item', () => {
    renderShell();
    window.location.hash = '#/projects/prj-42/workspace';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByTestId('page-project-workspace')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Workspace' })).toBeDefined();
    expect(screen.getByRole('link', { name: /Projects/ }).getAttribute('aria-current')).toBe(
      'page',
    );

    window.location.hash = '#/projects/prj-42';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByTestId('page-project-detail')).toBeDefined();
  });

  it('falls back to the chat for non-workspace project subpaths', () => {
    renderShell();
    window.location.hash = '#/projects/prj-42/not-a-route';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByTestId('page-chat')).toBeDefined();
  });

  it('falls back to the chat for unknown hashes', () => {
    renderShell();
    window.location.hash = '#/nonsense';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByTestId('page-chat')).toBeDefined();
  });

  it('collapses and expands the sidebar', () => {
    renderShell();
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' });
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeDefined();
  });

  it('opens the mobile drawer and closes it via the backdrop and Escape', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    // Drawer open: navigating closes it.
    fireEvent.click(screen.getByRole('link', { name: /Settings/ }));
    expect(screen.getByTestId('page-settings')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    // Backdrop is gone after Escape.
    expect(screen.queryByRole('presentation')).toBeNull();
  });

  it('routes to the documents page and marks it active', () => {
    renderShell();
    window.location.hash = '#/documents';
    fireEvent(window, new HashChangeEvent('hashchange'));
    // regression: the hash parser previously fell back to the dashboard here
    expect(screen.getByTestId('page-documents')).toBeDefined();
    expect(
      screen.getByRole('link', { name: /Document intelligence/ }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('navigates to the documents page from the sidebar', () => {
    renderShell();
    fireEvent.click(screen.getByRole('link', { name: /Document intelligence/ }));
    expect(window.location.hash).toBe('#/documents');
    expect(screen.getByTestId('page-documents')).toBeDefined();
  });

  it('routes to the AI provider settings page', () => {
    renderShell();
    window.location.hash = '#/settings/ai-providers';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByTestId('page-ai-providers')).toBeDefined();
    expect(screen.getByRole('link', { name: /AI providers/ }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('keeps the plain settings page reachable', () => {
    renderShell();
    window.location.hash = '#/settings';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByTestId('page-settings')).toBeDefined();
  });

  it('builds the bar as one strip: brand mark, title, then the account control', () => {
    const { container } = renderShell();

    const bar = container.querySelector('.v-topbar');
    expect(bar).not.toBeNull();
    if (!bar) throw new Error('no top bar');

    // Order is the reference's: mark, then the title it belongs to, then the
    // right-hand group. The mark is decorative because the title names the page.
    const brand = bar.querySelector('.v-topbar__brand img');
    expect(brand?.getAttribute('alt')).toBe('');
    expect(brand?.getAttribute('width')).toBe('22');

    const title = bar.querySelector('.v-topbar__title');
    expect(title?.tagName).toBe('H1');

    const children = Array.from(bar.children).map((child) => child.className);
    expect(children.indexOf('v-topbar__brand')).toBeLessThan(
      children.findIndex((name) => name.includes('v-topbar__context')),
    );

    // The reserved premium slot exists in the layout but draws nothing.
    const slot = bar.querySelector('.v-topbar__premium-slot');
    expect(slot?.children.length).toBe(0);
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws the account control as the reference glyph: document over a monitor', () => {
    const { container } = renderShell();

    const icon = container.querySelector('.v-topbar__account-icon');
    expect(icon).not.toBeNull();
    const svg = icon?.querySelector('svg');
    expect(svg).not.toBeNull();

    // Two rounded panels: the document (upper right) and the monitor (lower
    // left, in front of it). The knockout copy is what makes the overlap read.
    const panels = Array.from(svg?.querySelectorAll('rect') ?? []).map((rect) => ({
      x: Number(rect.getAttribute('x')),
      y: Number(rect.getAttribute('y')),
    }));
    expect(panels).toHaveLength(3);
    const document = panels[0];
    const monitor = panels[1];
    if (!document || !monitor) throw new Error('missing panels');
    expect(document.x).toBeGreaterThan(monitor.x);
    expect(document.y).toBeLessThan(monitor.y);
    expect(svg?.querySelector('.v-topbar__icon-knockout')).not.toBeNull();

    // Decorative: the button's own name carries the meaning.
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeDefined();
  });

  it('opens a small popup of icon rows from the account control', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));

    const panel = screen.getByRole('menu', { name: 'Account menu' });
    const rows = screen.getAllByRole('menuitem');
    expect(rows).toHaveLength(4);

    // Every row is an icon plus a label, the way the reference popup reads, and
    // the glyphs are decorative because the label already names the action.
    for (const row of rows) {
      const glyph = row.querySelector('.v-menu__glyph');
      expect(glyph).not.toBeNull();
      expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(rows.map((row) => row.textContent)).toEqual([
      'Theme: System',
      'Notifications',
      'Account',
      'Sign out',
    ]);
    expect(panel.contains(rows[0] as Node)).toBe(true);
  });

  it('keeps the premium slot empty and reaches notifications from the account menu', () => {
    const { container } = renderShell();

    // No status mark sits in the bar at all: the crown slot stays empty until
    // there is a real subscription behind it.
    expect(container.querySelector('.v-topbar__notify-button')).toBeNull();
    expect(container.querySelectorAll('.v-topbar__actions img')).toHaveLength(0);

    expect(screen.queryByRole('dialog', { name: 'Notifications' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Notifications' }));

    // The honest empty state is unchanged, it simply lives in a dialog now.
    const dialog = screen.getByRole('dialog', { name: 'Notifications' });
    expect(dialog.textContent).toContain('no notification source connected');
  });
});
