// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageCreditSummary } from '../api/message-credits';
import { ThemeProvider } from '../theme/ThemeProvider';
import { WorkspaceSheet, creditMeters, formatCredits, renewalLabel } from './WorkspaceSheet';

afterEach(cleanup);

function summary(
  over: {
    spent?: number;
    limit?: number | null;
    reserved?: number;
  } = {},
): MessageCreditSummary {
  const spent = over.spent ?? 87.33;
  return {
    wallet: { available: 100, reserved: over.reserved ?? 0, spent, spendable: 100 },
    month: {
      charges: 3,
      credits: spent,
      refunded: 0,
      open: 0,
      openCredits: 0,
      tokens: { input: 0, output: 0, cached: 0, uncached: 0 },
      byKind: [],
    },
    openReservations: [],
    settings: { monthlyLimit: over.limit === undefined ? 235 : over.limit, perRequestLimit: null },
  };
}

function setup(load: () => Promise<MessageCreditSummary>, over: { open?: boolean } = {}) {
  const props = {
    open: over.open ?? true,
    workspaceName: "Ijezie's workspace",
    onClose: vi.fn(),
    onOpenSettings: vi.fn(),
    loadCredits: load,
  };
  render(
    <ThemeProvider>
      <WorkspaceSheet {...props} />
    </ThemeProvider>,
  );
  return props;
}

describe('credit figures', () => {
  it('prints two places without trailing noise, the way 87.33 and 6.95 read', () => {
    expect(formatCredits(87.33)).toBe('87.33');
    expect(formatCredits(100)).toBe('100');
    expect(formatCredits(6.5)).toBe('6.5');
    expect(formatCredits(0.1 + 0.2)).toBe('0.3');
  });

  it('measures the month against its limit, and never invents a denominator', () => {
    const [meter] = creditMeters(summary({ spent: 87.33, limit: 235 }));
    expect(meter?.figure).toBe('87.33/235');
    expect(meter?.fraction).toBeCloseTo(0.3716, 3);

    const [open] = creditMeters(summary({ spent: 12, limit: null }));
    expect(open?.figure).toBe('12 used');
    expect(open?.fraction).toBeNull();
  });

  it('turns the bar red only when the limit is reached, and caps it at full', () => {
    const [meter] = creditMeters(summary({ spent: 300, limit: 235 }));
    expect(meter?.fraction).toBe(1);
    expect(meter?.tone).toBe('full');
    expect(creditMeters(summary({ spent: 10, limit: 235 }))[0]?.tone).toBe('ok');
  });

  it('draws a held-credits row only while something is held, and no daily or integration rows', () => {
    expect(creditMeters(summary())).toHaveLength(1);
    const held = creditMeters(summary({ reserved: 4 }));
    expect(held.map((m) => m.label)).toEqual(['Message credits', 'Held for work in progress']);
    const all = creditMeters(summary({ reserved: 4 })).map((m) => m.label.toLowerCase());
    expect(all.some((l) => l.includes('daily') || l.includes('integration'))).toBe(false);
  });

  it('renews on the first of next month, in UTC, as the server buckets charges', () => {
    expect(renewalLabel(new Date('2026-11-10T16:00:00Z'))).toBe('Renews December 1');
    expect(renewalLabel(new Date('2026-12-31T23:30:00Z'))).toBe('Renews January 1');
  });
});

describe('the workspace sheet', () => {
  it('shows the breathing skeleton while credits load, with no fake numbers', () => {
    setup(() => new Promise(() => undefined));
    expect(screen.getByRole('status', { name: 'Loading credits' })).toBeDefined();
    expect(document.querySelectorAll('.v-sheet__bone')).toHaveLength(4);
    expect(document.querySelector('.v-sheet__figure')).toBeNull();
    expect(document.querySelector('.v-sheet__credits')?.getAttribute('aria-busy')).toBe('true');
  });

  it('replaces the skeleton with the real card once credits arrive', async () => {
    setup(() => Promise.resolve(summary()));
    await waitFor(() => expect(screen.getByText('87.33/235')).toBeDefined());
    expect(document.querySelector('.v-sheet__skeleton')).toBeNull();
    expect(screen.getByText('Renews December 1', { exact: false })).toBeDefined();
    const bar = screen.getByRole('progressbar', { name: 'Message credits' });
    expect(bar.getAttribute('aria-valuenow')).toBe('37');
    const fill = bar.querySelector('.v-sheet__fill') as HTMLElement;
    expect(fill.style.inlineSize).toMatch(/^37\.1/);
  });

  it('says plainly when credits cannot be read, instead of a blank card', async () => {
    setup(() => Promise.reject(new Error('down')));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('could not be loaded');
    expect(document.querySelector('.v-sheet__skeleton')).toBeNull();
  });

  it('keeps the card its shape when credits cannot be read, so the sheet does not shrink', async () => {
    setup(() => Promise.reject(new Error('down')));
    await screen.findByRole('alert');
    const card = document.querySelector('.v-sheet__credits') as HTMLElement;
    // The reference's sheet is sized by this card, so the head and the meter stay
    // and only the figures go unknown. A bare sentence would collapse the sheet.
    expect(card.querySelector('.v-sheet__credits-title')?.textContent).toBe('Credits');
    expect(card.querySelectorAll('.v-sheet__meter')).toHaveLength(1);
    expect(card.querySelector('.v-sheet__meter-label')?.textContent).toBe('Message credits');
    expect(card.querySelector('.v-sheet__figure')?.textContent).toBe('—');
    // Unknown is not zero: no track claims a value it cannot know.
    expect(card.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('closes, then opens settings, from the Settings row', async () => {
    const props = setup(() => Promise.resolve(summary()));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and on a tap outside the sheet', () => {
    const props = setup(() => new Promise(() => undefined));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector('.v-sheet__scrim') as HTMLElement);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('is unreachable while closed, and reads credits only once it opens', () => {
    const load = vi.fn(() => new Promise<MessageCreditSummary>(() => undefined));
    setup(load, { open: false });
    const panel = document.querySelector('.v-sheet__panel') as HTMLElement;
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('the rows after Settings', () => {
  it('opens the real profile dialog, which writes both names', async () => {
    setup(() => Promise.resolve(summary()));
    fireEvent.click(screen.getByRole('button', { name: /View profile/ }));
    const dialog = await screen.findByRole('dialog', { name: /Your profile/i });
    expect(within(dialog).getByLabelText('Your name')).toBeDefined();
    expect(within(dialog).getByLabelText("Your assistant's name")).toBeDefined();
  });

  it('changes the real theme from the Appearance segments', () => {
    setup(() => Promise.resolve(summary()));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(document.documentElement.getAttribute('data-theme')).not.toBe('dark');
  });

  it('shows Language as the fact it is, not a control that opens nothing', () => {
    setup(() => Promise.resolve(summary()));
    const row = screen.getByText('Language').closest('.v-sheet__item') as HTMLElement;
    expect(row.querySelector('.v-sheet__value')?.textContent).toBe('English');
    expect(row.tagName).toBe('DIV');
    expect(row.querySelector('button')).toBeNull();
  });

  it('opens help with answers the app can stand behind', async () => {
    setup(() => Promise.resolve(summary()));
    fireEvent.click(screen.getByRole('button', { name: /Help & support/ }));
    const dialog = await screen.findByRole('dialog', { name: /Help & support/i });
    expect(dialog.textContent).toContain('Credits');
    expect(dialog.textContent).toContain('resets on the 1st');
  });

  it('draws the reference rows it cannot honour, each labelled and explained', async () => {
    setup(() => Promise.resolve(summary()));
    for (const [label, fact] of [
      ['Earn free credits', 'no rewards or referral programme'],
      ['Add members', 'belongs to one person'],
      ['Become an affiliate', 'no affiliate programme'],
      ['Log out', 'no accounts or sessions'],
    ] as const) {
      const row = screen.getByRole('button', { name: `${label}, not available yet` });
      expect(row.textContent).toContain('Soon');
      fireEvent.click(row);
      const dialog = await screen.findByRole('dialog', { name: label });
      expect(dialog.textContent).toContain(fact);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: label })).toBeNull());
    }
  });

  it('does not act when a placeholder is tapped: nothing navigates, nothing is signed out', async () => {
    const props = setup(() => Promise.resolve(summary()));
    fireEvent.click(screen.getByRole('button', { name: 'Log out, not available yet' }));
    await screen.findByRole('dialog', { name: 'Log out' });
    expect(props.onOpenSettings).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('offers one modal at a time: the sheet steps aside for its own dialog', async () => {
    setup(() => Promise.resolve(summary()));
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add members, not available yet' }));
    await screen.findByRole('dialog', { name: 'Add members' });
    const modals = document.querySelectorAll('[aria-modal="true"]');
    expect(modals).toHaveLength(1);
    expect(modals[0]?.textContent).toContain('Add members');
    expect(document.querySelector('.v-sheet__panel')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the reference order: earn, members, settings, then the account rows', () => {
    setup(() => Promise.resolve(summary()));
    const labels = [...document.querySelectorAll('.v-sheet__item-label')].map((e) => e.textContent);
    expect(labels).toEqual([
      'Earn free credits',
      'Add members',
      'Settings',
      'View profile',
      'Account preferences',
      'Become an affiliate',
      'Language',
      'Appearance',
      'Help & support',
      'Log out',
    ]);
  });
});
