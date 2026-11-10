// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ThemeProvider } from '../theme/ThemeProvider';
import { AppShell } from './AppShell';

/**
 * jsdom has no layout, so the shell's "is this a wide screen" question is answered
 * by the stub below. Tests that care about the phone assert narrow explicitly.
 */
function stubWidth(wide: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: wide && query.includes('min-width: 901px'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

beforeEach(() => stubWidth(true));

afterEach(() => {
  cleanup();
  window.location.hash = '';
  vi.unstubAllGlobals();
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
    expect(screen.getByText('Veltravia')).toBeDefined();
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

  it('stands the navigation open on a wide screen, with no hamburger asked for', () => {
    renderShell();
    const drawer = screen.getByTestId('mobile-drawer');
    // One panel, two frames: wide, it is the page's own column.
    expect(drawer.classList.contains('v-drawer--docked')).toBe(true);
    expect(drawer.classList.contains('v-drawer--open')).toBe(true);
    expect(drawer.querySelector('.v-drawer__scrim')).toBeNull();
    // The phone's close control is not what a column offers; the column offers to
    // be put away, which is the same control wearing its own label.
    expect(screen.queryByRole('button', { name: 'Close navigation' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Put the navigation column away' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Open navigation' })).toBeNull();
  });

  it('puts the column away from its own control and brings the hamburger back', () => {
    renderShell();
    const drawer = screen.getByTestId('mobile-drawer');
    fireEvent.click(screen.getByRole('button', { name: 'Put the navigation column away' }));
    // Not closed as a drawer is closed: the column is gone and the page has the
    // whole width, so the page's own control reappears to fetch it back.
    expect(drawer.classList.contains('v-drawer--open')).toBe(false);
    expect(drawer.classList.contains('v-drawer--docked')).toBe(false);
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(drawer.classList.contains('v-drawer--open')).toBe(true);
  });

  it('keeps the column standing when a row navigates', () => {
    renderShell();
    const drawer = screen.getByTestId('mobile-drawer');
    fireEvent.click(within(drawer).getByRole('link', { name: /Settings/ }));
    expect(screen.getByTestId('page-settings')).toBeDefined();
    // A row tap closes the drawer so the page is visible; on a wide screen there
    // is no drawer to close and the column stays where it is.
    expect(drawer.classList.contains('v-drawer--open')).toBe(true);
    expect(drawer.classList.contains('v-drawer--docked')).toBe(true);
  });

  it('keeps the old rail out of the website build', () => {
    renderShell();
    expect(document.querySelector('.v-sidebar')).toBeNull();
    expect(screen.queryByTestId('sidebar')).toBeNull();
  });

  it('opens the phone drawer, navigates from it, and closes via the scrim and Escape', () => {
    stubWidth(false);
    renderShell();
    // The browser gets the website drawer; the packaged app keeps its own menu.
    const drawer = screen.getByTestId('mobile-drawer');
    expect(drawer.classList.contains('v-drawer--open')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(drawer.classList.contains('v-drawer--open')).toBe(true);

    // Navigating from the drawer lands on the page and closes the drawer.
    fireEvent.click(within(drawer).getByRole('link', { name: 'Projects' }));
    expect(screen.getByTestId('page-projects')).toBeDefined();
    expect(drawer.classList.contains('v-drawer--open')).toBe(false);

    // Tapping the dimmed area closes it without navigating anywhere.
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.click(drawer.querySelector('.v-drawer__scrim') as Element);
    expect(drawer.classList.contains('v-drawer--open')).toBe(false);

    // And so does Escape.
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(drawer.classList.contains('v-drawer--open')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(drawer.classList.contains('v-drawer--open')).toBe(false);
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

  it('navigates to the documents page from the panel', () => {
    renderShell();
    // The AI workspace group folds away; its rows appear once it is opened.
    fireEvent.click(screen.getByRole('button', { name: /AI workspace/ }));
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

    // Drawn solid: a 1.6 stroke at 22px, not the shell's thin 16px default, so
    // it reads as dark as the title beside it.
    const strokes = Array.from(svg?.querySelectorAll('g') ?? []).map((group) =>
      Number(group.getAttribute('stroke-width')),
    );
    expect(strokes).toEqual([1.6, 3.6, 1.6]);
    expect(container.querySelector('.v-topbar__account-icon .v-icon')).not.toBeNull();

    // Decorative: the button's own name carries the meaning.
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('button', { name: 'Panel menu' })).toBeDefined();
  });

  it('opens a two-row popup: Notes and Computer, both marked not built yet', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Panel menu' }));

    const panel = screen.getByRole('menu', { name: 'Panel menu' });
    const rows = screen.getAllByRole('menuitem');
    expect(rows).toHaveLength(2);

    expect(rows.map((row) => row.querySelector('.v-menu__item-label')?.textContent)).toEqual([
      'Notes',
      'Computer',
    ]);

    // Every row is an icon plus a label plus the honest "Soon" note, and the
    // glyph is decorative because the label names the row.
    for (const row of rows) {
      const glyph = row.querySelector('.v-menu__glyph');
      expect(glyph).not.toBeNull();
      expect(glyph?.getAttribute('aria-hidden')).toBe('true');
      expect(row.querySelector('.v-menu__hint')?.textContent).toBe('Soon');
    }

    // Nothing in the popup pretends to work: both rows are disabled until the
    // notes and computer surfaces exist.
    for (const row of rows) {
      expect((row as HTMLButtonElement).disabled).toBe(true);
    }
    expect(panel.contains(rows[0] as Node)).toBe(true);
  });

  it('keeps the premium slot empty', () => {
    const { container } = renderShell();

    // No status mark sits in the bar at all: the crown slot stays empty until
    // there is a real subscription behind it.
    expect(container.querySelector('.v-topbar__notify-button')).toBeNull();
    expect(container.querySelectorAll('.v-topbar__actions img')).toHaveLength(0);
  });
});
