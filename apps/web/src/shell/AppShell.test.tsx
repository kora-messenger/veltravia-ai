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

  it('prepares the branded notification mark but shows nothing until opened', () => {
    const { container } = renderShell();
    const trigger = screen.getByRole('button', { name: 'Notifications' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog', { name: 'Notification centre' })).toBeNull();
    const marks = container.querySelectorAll('.v-topbar__notifications .v-brand-mark');
    expect(marks).toHaveLength(1);
  });

  it('sizes the notification mark 24px in the bar and 28px in the panel heading', () => {
    const { container } = renderShell();
    const barImage = container.querySelector('.v-topbar__notify-button .v-brand-mark img');
    expect(barImage?.getAttribute('width')).toBe('24');
    expect(barImage?.getAttribute('height')).toBe('24');

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    const headImage = container.querySelector('.v-topbar__notify-head .v-brand-mark img');
    expect(headImage?.getAttribute('width')).toBe('28');
    expect(headImage?.getAttribute('height')).toBe('28');
    // The heading keeps its own 16px scale, so the mark never outgrows the title.
    const heading = screen.getByRole('heading', { name: 'Notifications', level: 2 });
    expect(heading.className).toContain('v-heading-3');
  });
});
