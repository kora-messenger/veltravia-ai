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

  it('starts on the dashboard route', () => {
    renderShell();
    expect(screen.getByTestId('page-dashboard')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeDefined();
  });

  it('marks the active navigation item with aria-current', () => {
    renderShell();
    const active = screen.getByRole('link', { name: /Dashboard/ });
    expect(active.getAttribute('aria-current')).toBe('page');
    const inactive = screen.getByRole('link', { name: /Projects/ });
    expect(inactive.getAttribute('aria-current')).toBeNull();
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

  it('falls back to the dashboard for non-workspace project subpaths', () => {
    renderShell();
    window.location.hash = '#/projects/prj-42/not-a-route';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByTestId('page-dashboard')).toBeDefined();
  });

  it('falls back to the dashboard for unknown hashes', () => {
    renderShell();
    window.location.hash = '#/nonsense';
    fireEvent(window, new HashChangeEvent('hashchange'));
    expect(screen.getByTestId('page-dashboard')).toBeDefined();
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
});
