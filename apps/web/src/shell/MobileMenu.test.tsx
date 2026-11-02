// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileMenu } from './MobileMenu';
import { ROUTES } from './useHashRoute';

afterEach(cleanup);

function setup(over: Partial<Parameters<typeof MobileMenu>[0]> = {}) {
  const props = {
    open: true,
    activeRouteId: 'chat',
    onNavigate: vi.fn(),
    onNewChat: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<MobileMenu {...props} />);
  return props;
}

describe('the phone navigation drawer', () => {
  it('lists every route the app has, once, and invents none', () => {
    setup();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const links = within(nav).getAllByRole('link');
    // Every route gets exactly one row; the extra link is the profile circle.
    const rows = links.filter((link) => !link.classList.contains('v-mmenu__profile'));
    expect(rows).toHaveLength(ROUTES.length);
    expect(new Set(rows.map((row) => row.textContent)).size).toBe(ROUTES.length);
    // "Chat" appears twice by design (its row and the floating pill), so rows are
    // matched by their own label node rather than by free text.
    const labels = Array.from(nav.querySelectorAll('.v-mmenu__label')).map((n) => n.textContent);
    for (const route of ROUTES) expect(labels).toContain(route.title);
  });

  it('puts the everyday places first and the rest under one quiet label', () => {
    setup();
    const labels = Array.from(document.querySelectorAll('.v-mmenu__label')).map(
      (node) => node.textContent,
    );
    expect(labels.slice(0, 5)).toEqual([
      'Chat',
      'Projects',
      'App Builder',
      'Files & artifacts',
      'Dashboard',
    ]);
    expect(screen.getByText('Tools')).toBeDefined();
    // The group label sits between the two lists.
    const all = Array.from(document.querySelectorAll('.v-mmenu__list, .v-mmenu__group'));
    expect(all.map((node) => node.className.includes('group'))).toEqual([false, true, false]);
  });

  it('marks the current page and no other', () => {
    setup({ activeRouteId: 'projects' });
    const current = document.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe('Projects');
  });

  it('opens a page and closes itself', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('link', { name: 'Projects' }));
    expect(props.onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'projects' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('starts a new chat from the floating Chat control and closes itself', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(props.onNewChat).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the dimmed area outside the panel is tapped', () => {
    const props = setup();
    fireEvent.click(document.querySelector('.v-mmenu__scrim') as Element);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it('reaches settings from the profile circle', () => {
    const props = setup();
    fireEvent.click(document.querySelector('.v-mmenu__profile') as Element);
    expect(props.onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'settings' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('is hidden from keyboards and screen readers while closed', () => {
    setup({ open: false });
    const panel = screen.getByTestId('mobile-menu').querySelector('nav') as HTMLElement;
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('mobile-menu').classList.contains('v-mmenu--open')).toBe(false);
  });

  it('is reachable and focused when open', () => {
    setup();
    const panel = screen.getByTestId('mobile-menu').querySelector('nav') as HTMLElement;
    expect(panel.getAttribute('aria-hidden')).toBe('false');
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(panel);
  });

  it('names no icon-only control without a label', () => {
    setup();
    const profile = document.querySelector('.v-mmenu__profile') as HTMLElement;
    expect(profile.getAttribute('aria-label')).toMatch(/^Settings for /);
  });
});
