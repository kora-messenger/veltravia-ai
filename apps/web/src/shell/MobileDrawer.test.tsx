// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileDrawer } from './MobileDrawer';
import { RECENT_LIMIT, createConversation, listConversations } from '../pages/chat/conversations';

/**
 * The website's drawer is measured from a reference capture, so these pin the
 * things a screenshot cannot show: that the two small cards really open, that
 * every row and menu item leads somewhere, and that the conversation cap and
 * "See all" agree with each other.
 */

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

function setup(over: Partial<Parameters<typeof MobileDrawer>[0]> = {}) {
  const props = {
    open: true,
    activeRouteId: 'chat',
    onNavigate: vi.fn(),
    onNewChat: vi.fn(),
    onOpenConversation: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  const view = render(<MobileDrawer {...props} />);
  return { props, view };
}

function seed(count: number) {
  for (let index = 0; index < count; index += 1) {
    createConversation({ title: `Conversation ${index + 1}`, at: 1_000 + index });
  }
}

const drawer = () => screen.getByTestId('mobile-drawer');

describe('the website drawer', () => {
  it('opens with the mark and a close control, and no back arrow', () => {
    setup();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('button', { name: 'Close navigation' })).toBeDefined();
    // Deliberate departure from the reference: there is nowhere to go back to.
    expect(within(nav).queryByRole('button', { name: /back/i })).toBeNull();
    expect(within(nav).queryByRole('link', { name: /back/i })).toBeNull();
  });

  it('shows no upgrade card while the product is free', () => {
    setup();
    expect(screen.queryByText(/upgrade/i)).toBeNull();
  });

  it('pins the agent and a new conversation, and lists the everyday places', () => {
    setup();
    expect(screen.getByText('My Engineer')).toBeDefined();
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeDefined();
    const labels = Array.from(document.querySelectorAll('.v-drawer__label')).map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(['Chat', 'Projects', 'App Builder', 'Files & artifacts', 'Dashboard']);
  });

  it('has no More row yet: the secondary destinations are not listed', () => {
    setup();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).queryByRole('link', { name: 'Model routing' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Knowledge synthesis' })).toBeNull();
  });

  it('reaches settings from the agent row, the way the reference does', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('link', { name: /My Engineer/ }));
    expect(props.onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'settings' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('starts a conversation from the pinned row', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(props.onNewChat).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('says plainly that there are no conversations yet', () => {
    setup();
    expect(screen.getByText(/No conversations yet/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /See all/ })).toBeNull();
  });

  it('lists saved conversations and reopens one', () => {
    seed(3);
    const { props } = setup();
    const rows = screen.getAllByRole('button', { name: /^Conversation \d/ });
    expect(rows).toHaveLength(3);
    // Newest first: the last one created sits at the top.
    expect(rows[0]?.textContent).toContain('Conversation 3');
    fireEvent.click(rows[0]!);
    expect(props.onOpenConversation).toHaveBeenCalledWith(expect.any(String));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('offers See all only once there are more than nine, and shows the rest', () => {
    seed(RECENT_LIMIT);
    setup();
    expect(screen.getAllByRole('button', { name: /^Conversation \d/ })).toHaveLength(RECENT_LIMIT);
    expect(screen.queryByRole('button', { name: 'See all…' })).toBeNull();

    cleanup();
    window.localStorage.clear();
    seed(RECENT_LIMIT + 3);
    setup();
    expect(screen.getAllByRole('button', { name: /^Conversation \d/ })).toHaveLength(RECENT_LIMIT);
    fireEvent.click(screen.getByRole('button', { name: 'See all…' }));
    expect(screen.getAllByRole('button', { name: /^Conversation \d/ })).toHaveLength(
      RECENT_LIMIT + 3,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getAllByRole('button', { name: /^Conversation \d/ })).toHaveLength(RECENT_LIMIT);
  });

  it('opens a small card from the three dots with Rename, Archive and Delete', () => {
    seed(1);
    setup();
    const trigger = screen.getByRole('button', { name: 'Actions for Conversation 1' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const card = screen.getByRole('menu');
    expect(
      within(card)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Rename', 'Archive', 'Delete']);
  });

  it('renames a conversation from the card', () => {
    seed(1);
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Conversation 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByRole('textbox', { name: 'Conversation name' });
    fireEvent.change(field, { target: { value: 'Vault wiring' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Actions for Vault wiring' })).toBeDefined();
    expect(listConversations()[0]?.title).toBe('Vault wiring');
  });

  it('archives a conversation out of the list and can restore it', () => {
    seed(2);
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Conversation 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(screen.queryByRole('button', { name: 'Actions for Conversation 1' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Conversation \d/ })).toHaveLength(1);

    // The filter shows what was archived, and offers it back.
    fireEvent.click(screen.getByRole('button', { name: 'Show archived conversations' }));
    const archived = screen.getByRole('button', { name: /^Conversation 1/ });
    expect(archived.textContent).toContain('Archived');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Conversation 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide archived conversations' }));
    expect(screen.getAllByRole('button', { name: /^Conversation \d/ })).toHaveLength(2);
  });

  it('asks before deleting, and keeps the conversation if told to', () => {
    seed(1);
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Conversation 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(screen.getByText('Delete this conversation?')).toBeDefined();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Keep it' }));
    expect(listConversations()).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Conversation 1' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(listConversations()).toHaveLength(0);
    expect(screen.getByText(/No conversations yet/)).toBeDefined();
  });

  it('pins a footer that names the workspace and leads to settings', () => {
    const { props } = setup();
    const footer = document.querySelector('.v-drawer__foot') as HTMLElement;
    expect(footer.textContent).toContain('Personal workspace');
    fireEvent.click(within(footer).getByRole('link'));
    expect(props.onNavigate).toHaveBeenCalledWith(expect.objectContaining({ id: 'settings' }));
  });

  it('is hidden from keyboards and screen readers while closed', () => {
    setup({ open: false });
    const panel = drawer().querySelector('nav') as HTMLElement;
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(drawer().classList.contains('v-drawer--open')).toBe(false);
  });

  it('is reachable and focused when open', () => {
    setup();
    const panel = drawer().querySelector('nav') as HTMLElement;
    expect(panel.getAttribute('aria-hidden')).toBe('false');
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(panel);
  });
});
