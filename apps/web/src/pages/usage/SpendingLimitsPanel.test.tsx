// @vitest-environment jsdom
/**
 * Spending limits panel (Step 59).
 *
 * The assertions follow what the panel promises, and deliberately not what it
 * draws:
 *
 *  - an account with no limit is told so in words, not shown a made-up ceiling;
 *  - the consumption shown includes credit that is held, because a hold is what
 *    actually decides a refusal;
 *  - soft and hard read differently without relying on colour;
 *  - a write carries the version the screen read, so a stale screen cannot
 *    overwrite somebody else's change: it reloads and says why.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import type { SpendingLimitsOverview } from '../../api/spending-limits';
import { SpendingLimitsPanel } from './SpendingLimitsPanel';

afterEach(cleanup);

function overview(overrides: Partial<SpendingLimitsOverview> = {}): SpendingLimitsOverview {
  return {
    scopes: [{ scope: 'user', workspaceId: null, projectId: null, policy: null, inherited: false }],
    limits: [],
    windows: [],
    usage: { today: [], week: [], month: [] },
    heldCredits: 0,
    perOperationLimit: null,
    maxReservedCredits: null,
    enforcement: 'unconfigured',
    platform: { maxLimitPerRule: 100_000, enforcementDisabled: false },
    wallet: { available: 120, reserved: 0, spent: 0 },
    events: [],
    generatedAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

const policy = {
  id: 'pol_user',
  scope: 'user' as const,
  workspaceId: null,
  projectId: null,
  version: 3,
  rules: [
    {
      id: 'monthly-ai',
      target: 'ai_messages' as const,
      period: 'monthly' as const,
      limit: 200,
      mode: 'hard' as const,
      warnAt: [0.8],
    },
  ],
  perOperationLimit: 40,
  maxReservedCredits: null,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-12T09:00:00.000Z',
};

describe('spending limits panel', () => {
  it('says plainly that nothing is limited yet', async () => {
    const load = vi.fn(async () => overview());
    render(<SpendingLimitsPanel deps={{ load }} />);

    expect(await screen.findByText(/No limit is set, so nothing is refused/i)).toBeTruthy();
    expect(screen.getByText(/Nothing is limited yet/i)).toBeTruthy();
    // No invented ceiling: an unset ceiling reads as "no ceiling", not as zero.
    expect(screen.getAllByText('no ceiling').length).toBeGreaterThan(0);
  });

  it('counts held credit in what has been used, and prints the mode', async () => {
    const load = vi.fn(async () =>
      overview({
        scopes: [{ scope: 'user', workspaceId: null, projectId: null, policy, inherited: false }],
        enforcement: 'enforced',
        heldCredits: 12,
        perOperationLimit: 40,
        limits: [
          {
            ruleId: 'monthly-ai',
            scope: 'user',
            label: 'Your monthly chat and messages limit',
            target: 'ai_messages',
            targetLabel: 'Chat and messages',
            period: 'monthly',
            mode: 'hard',
            limit: 200,
            consumed: 210,
            remaining: 0,
            state: 'reached',
            resetsAt: '2026-12-01T00:00:00.000Z',
            warnAt: [0.8],
          },
          {
            ruleId: 'weekly-all',
            scope: 'user',
            label: 'Your weekly limit',
            target: 'all',
            targetLabel: 'Everything',
            period: 'weekly',
            mode: 'soft',
            limit: 500,
            consumed: 100,
            remaining: 400,
            state: 'clear',
            resetsAt: '2026-11-16T00:00:00.000Z',
            warnAt: [],
          },
        ],
      }),
    );

    render(<SpendingLimitsPanel deps={{ load }} />);

    await screen.findByText(/Used up/);
    expect(screen.getByText(/Refuses at the limit/)).toBeTruthy();
    expect(screen.getByText(/Warns only/)).toBeTruthy();
    // Consumed can exceed the limit; the row says how much is left, never below zero.
    expect(screen.getByText(/210 credits used, 0 credits left/i)).toBeTruthy();
    // 12 held credits are shown as held, not folded into a balance.
    expect(screen.getByText('Held right now')).toBeTruthy();
    expect(screen.getByText('12 credits')).toBeTruthy();
    // The progress bar is capped at the limit instead of overflowing it.
    const bars = screen.getAllByRole('progressbar');
    expect(bars).toHaveLength(2);
    expect(bars[0]?.getAttribute('aria-valuenow')).toBe('210');
  });

  it('sends the version it read, so a stale screen cannot overwrite a change', async () => {
    const load = vi.fn(async () =>
      overview({
        scopes: [{ scope: 'user', workspaceId: null, projectId: null, policy, inherited: false }],
        enforcement: 'enforced',
      }),
    );
    const save = vi.fn(async () => policy);
    render(<SpendingLimitsPanel deps={{ load, save }} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Save change' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const input = save.mock.calls[0]?.[0] as { expectedVersion: number | null };
    expect(input.expectedVersion).toBe(3);
  });

  it('reloads and explains when somebody else saved first', async () => {
    const load = vi.fn(async () =>
      overview({
        scopes: [{ scope: 'user', workspaceId: null, projectId: null, policy, inherited: false }],
        enforcement: 'enforced',
      }),
    );
    const save = vi.fn(async () => {
      throw new ApiError(409, 'STALE_VERSION', 'That limit changed since this screen loaded it.');
    });
    render(<SpendingLimitsPanel deps={{ load, save }} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Save change' }));

    expect(await screen.findByText(/Somebody changed this limit first/i)).toBeTruthy();
    // Reloaded rather than retried: one read on mount, one after the conflict.
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('says a limit was removed and that nothing is refused afterwards', async () => {
    let current = overview({
      scopes: [{ scope: 'user', workspaceId: null, projectId: null, policy, inherited: false }],
      enforcement: 'enforced',
    });
    const load = vi.fn(async () => current);
    const reset = vi.fn(async () => {
      current = overview();
    });
    render(<SpendingLimitsPanel deps={{ load, reset }} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove limit' }));

    expect(await screen.findByText(/Limit removed/i)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(/No limit is set, so nothing is refused/i)).toBeTruthy(),
    );
    const input = reset.mock.calls[0]?.[0] as { expectedVersion: number };
    expect(input.expectedVersion).toBe(3);
  });
});
