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

  it('puts the everyday places first, then the AI tools under one quiet label', () => {
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
    expect(screen.getByText('AI workspace')).toBeDefined();
    expect(screen.getByText('Account')).toBeDefined();
    // Each group label sits between two lists: everyday, AI, account.
    const all = Array.from(document.querySelectorAll('.v-mmenu__list, .v-mmenu__group'));
    expect(all.map((node) => node.className.includes('group'))).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it('files every AI tool under AI workspace and settings outside it', () => {
    setup();
    const groups = Array.from(document.querySelectorAll('.v-mmenu__list, .v-mmenu__group'));
    const labelsOf = (list: Element) =>
      Array.from(list.querySelectorAll('.v-mmenu__label')).map((n) => n.textContent);
    const ai = labelsOf(groups[2]!);
    expect(ai).toEqual([
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
    ]);
    const account = labelsOf(groups[4]!);
    expect(account).toContain('Settings');
    expect(account).not.toContain('Reasoning workspace');
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

  it('opens the profile from the circle, where both names can be changed', () => {
    const props = setup();
    fireEvent.click(document.querySelector('.v-mmenu__profile') as Element);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    // Settings keeps its own row; the circle is the profile itself.
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByLabelText('Your name')).toBeDefined();
    expect(screen.getByLabelText("Your assistant's name")).toBeDefined();
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
    expect(profile.getAttribute('aria-label')).toMatch(/^Profile for /);
  });
});
