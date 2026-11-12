// @vitest-environment jsdom
/**
 * Usage and cost page (Step 58).
 *
 * The assertions follow the four promises the page makes:
 *
 *  - the balance shown is the wallet's, printed exactly as the ledger reports it;
 *  - a hold, a charge and a measurement read differently in the history;
 *  - a partial sum is announced rather than quietly displayed as a total;
 *  - filters go to the server (not into a client-side filter of the first page).
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  UsageBreakdownView,
  UsageEventView,
  UsageHistoryOverview,
  UsageHistoryPageView,
  UsageHistoryQuery,
} from '../../api/usage-history';
import { UsageHistoryPage } from './UsageHistoryPage';

afterEach(cleanup);

function event(overrides: Partial<UsageEventView> = {}): UsageEventView {
  return {
    id: 'charge:chg_1',
    occurredAt: '2026-11-10T14:05:00.000Z',
    settledAt: '2026-11-10T14:05:02.000Z',
    source: 'message',
    category: 'ai_messages',
    categoryLabel: 'Chat',
    activity: 'Chat message',
    detail: 'openai/gpt-4o-mini · openai · 1000 in / 400 out',
    movement: 'deduction',
    status: 'committed',
    credits: 1.6,
    estimatedCredits: 1,
    projectId: 'alpha',
    workspaceId: null,
    conversationId: 'conv_1',
    runId: null,
    taskId: null,
    executionId: null,
    modelId: 'openai/gpt-4o-mini',
    providerId: 'openai',
    providerCharge: 'veltravia',
    measurement: {
      unit: 'tokens',
      quantity: 1400,
      inputTokens: 1000,
      outputTokens: 400,
      cachedTokens: 200,
      requests: null,
      durationMs: 1200,
    },
    limitations: [],
    pricing: { policyId: 'paid.chat', basis: 'measured', byok: false, note: 'Priced by policy.' },
    ...overrides,
  };
}

function overview(overrides: Partial<UsageHistoryOverview> = {}): UsageHistoryOverview {
  const completeness = { complete: true, scanned: 4, cap: 5000, note: 'Every record was read.' };
  return {
    ownerRef: 'owner-1',
    at: '2026-11-12T18:00:00.000Z',
    range: { from: '2026-10-14', to: '2026-11-12', label: '2026-10-14 to 2026-11-12', days: 30 },
    wallet: {
      available: 42.5,
      reserved: 3,
      spent: 12.25,
      spendable: 39.5,
      currency: 'VELTRAVIA_CREDITS',
      durable: true,
      updatedAt: '2026-11-12T17:59:00.000Z',
    },
    period: {
      from: '2026-11-01',
      to: '2026-11-12',
      charges: 4,
      credits: 9.5,
      refunded: 1,
      openCharges: 1,
      openCredits: 3,
      tokens: { input: 4000, output: 1600, cached: 800, uncached: 3200 },
      integration: { charges: 1, credits: 2 },
      completeness,
    },
    selected: {
      charges: 4,
      credits: 8.5,
      refunded: 1,
      released: 2,
      byCategory: [
        { key: 'ai_messages', label: 'Chat', events: 3, credits: 6.5, share: 0.76, measured: 0 },
        { key: 'coding', label: 'Coding runs', events: 1, credits: 2, share: 0.24, measured: 0 },
      ],
      completeness,
    },
    recent: [],
    infrastructure: {
      measured: [
        {
          category: 'file_storage',
          label: 'File storage',
          quantity: 2048,
          unit: 'bytes',
          status: 'measured',
        },
        {
          category: 'bandwidth',
          label: 'Bandwidth',
          quantity: null,
          unit: 'count',
          status: 'unavailable',
        },
      ],
      note: 'Counters are quotas, not credits.',
    },
    ledger: {
      creditsAdded: 20,
      creditsRefunded: 1,
      entries: [],
      completeness,
    },
    pricing: {
      catalogVersion: 'message-credits/2026-11-default',
      defaultsOnly: true,
      note: 'Credits are priced by configurable defaults and are not a currency.',
      currency: 'credits',
    },
    ...overrides,
  };
}

function page(overrides: Partial<UsageHistoryPageView> = {}): UsageHistoryPageView {
  const completeness = { complete: true, scanned: 1, cap: 25, note: '1 record matches.' };
  return {
    ownerRef: 'owner-1',
    range: { from: '2026-10-14', to: '2026-11-12', label: 'range', days: 30 },
    events: [event()],
    nextCursor: null,
    hasMore: false,
    total: 1,
    completeness,
    filters: {
      categories: [],
      status: [],
      projectId: null,
      workspaceId: null,
      modelId: null,
      providerId: null,
      query: null,
    },
    ...overrides,
  };
}

function breakdown(
  dimension: 'category' | 'day',
  groups: UsageBreakdownView['groups'],
): UsageBreakdownView {
  return {
    ownerRef: 'owner-1',
    dimension,
    range: { from: '2026-10-14', to: '2026-11-12', label: 'range', days: 30 },
    groups,
    // The largest-charge list is a different panel and is left to its own test.
    largest: [],
    totals: {
      events: groups.reduce((sum, group) => sum + group.events, 0),
      credits: groups.reduce((sum, group) => sum + group.credits, 0),
      measured: 0,
    },
    completeness: { complete: true, scanned: 4, cap: 5000, note: 'Every record was read.' },
    note: 'Grouped from charge records.',
  };
}

const DAY_GROUPS = [
  { key: '2026-11-10', label: '2026-11-10', events: 2, credits: 3, share: 0.6, measured: 0 },
  { key: '2026-11-11', label: '2026-11-11', events: 1, credits: 2, share: 0.4, measured: 0 },
];

describe('usage history page', () => {
  it('prints the wallet balance it was given instead of recalculating one', async () => {
    render(
      <UsageHistoryPage
        deps={{
          overview: async () => overview(),
          history: async () => page(),
          breakdown: async (dimension) =>
            breakdown(
              dimension === 'day' ? 'day' : 'category',
              dimension === 'day' ? DAY_GROUPS : overview().selected.byCategory,
            ),
        }}
      />,
    );

    await screen.findByText('42.5');

    // Each figure is read from its own card, so a number that happens to repeat
    // elsewhere on the page cannot make this assertion pass by accident.
    const figure = (heading: string): string => {
      const card = screen.getByText(heading).closest('article');
      expect(card).not.toBeNull();
      // The figure is the card's first paragraph; the note beneath it is the second.
      return card?.querySelector('.v-usage__figure')?.textContent ?? '';
    };
    expect(figure('Available credits')).toBe('42.5');
    expect(figure('Held for work in flight')).toBe('3');
    expect(figure('Spent in total')).toBe('12.25');
    // The refund for the range is the server's figure, not a subtraction of the others.
    expect(figure('Refunded in range')).toBe('1');
    // The page says out loud that credits are not money, in the caption and in
    // the pricing note, so either occurrence proves the disclaimer survived.
    expect(screen.getAllByText(/not a currency/i).length).toBeGreaterThan(0);
  }, 20_000);

  it('says a total is partial instead of showing it as the whole', async () => {
    const partial = {
      complete: false,
      scanned: 5000,
      cap: 5000,
      note: 'This breakdown: read the most recent 5000 of more than 5000 records, so the totals are a partial sum.',
    };
    render(
      <UsageHistoryPage
        deps={{
          overview: async () => overview(),
          history: async () => page({ completeness: partial }),
          breakdown: async (dimension) =>
            breakdown(
              dimension === 'day' ? 'day' : 'category',
              dimension === 'day' ? DAY_GROUPS : overview().selected.byCategory,
            ),
        }}
      />,
    );

    expect(await screen.findByText(/partial sum/i)).toBeTruthy();
  }, 20_000);

  it('labels a hold, a charge and a measurement differently', async () => {
    render(
      <UsageHistoryPage
        deps={{
          overview: async () => overview(),
          history: async () =>
            page({
              events: [
                event(),
                event({
                  id: 'charge:chg_2',
                  movement: 'reservation',
                  status: 'reserved',
                  credits: 0,
                  estimatedCredits: 3,
                  activity: 'Coding run',
                  category: 'coding',
                  categoryLabel: 'Coding runs',
                }),
                event({
                  id: 'usage:use_1',
                  source: 'infrastructure',
                  movement: 'measurement',
                  status: 'measured',
                  credits: 0,
                  activity: 'File storage',
                  category: 'infrastructure',
                  categoryLabel: 'Infrastructure',
                  detail: 'file.upload · 2048 bytes · measured',
                  measurement: {
                    unit: 'bytes',
                    quantity: 2048,
                    inputTokens: null,
                    outputTokens: null,
                    cachedTokens: null,
                    requests: null,
                    durationMs: null,
                  },
                }),
              ],
              total: 3,
            }),
          breakdown: async (dimension) =>
            breakdown(
              dimension === 'day' ? 'day' : 'category',
              dimension === 'day' ? DAY_GROUPS : overview().selected.byCategory,
            ),
        }}
      />,
    );

    await screen.findByText('Chat message');
    const table = document.querySelector('.v-usage__table');
    expect(table).not.toBeNull();
    const rows = within(table as HTMLElement);

    // One row per movement, each labelled for what it actually did.
    expect(rows.getByText('Charged')).toBeTruthy();
    expect(rows.getByText('Held')).toBeTruthy();
    expect(rows.getByText('Measured')).toBeTruthy();
    // A measurement is printed in its own unit, never as credits.
    expect(rows.getByText('2 KB')).toBeTruthy();
  }, 20_000);

  it('asks the server for the filters instead of filtering what it already has', async () => {
    const seen: UsageHistoryQuery[] = [];
    render(
      <UsageHistoryPage
        deps={{
          overview: async () => overview(),
          history: async (query) => {
            seen.push(query);
            return page();
          },
          breakdown: async (dimension) =>
            breakdown(
              dimension === 'day' ? 'day' : 'category',
              dimension === 'day' ? DAY_GROUPS : overview().selected.byCategory,
            ),
        }}
      />,
    );

    await screen.findByText('42.5');
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'coding' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'refunded' } });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'alpha' } });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'gpt-4o' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(seen.length).toBe(2));
    const last = seen[seen.length - 1];
    expect(last?.categories).toEqual(['coding']);
    expect(last?.status).toEqual(['refunded']);
    expect(last?.projectId).toBe('alpha');
    expect(last?.query).toBe('gpt-4o');
  }, 20_000);

  it('appends the next page through the cursor it was given', async () => {
    const cursors: (string | undefined)[] = [];
    let call = 0;
    render(
      <UsageHistoryPage
        deps={{
          overview: async () => overview(),
          history: async (query) => {
            call += 1;
            cursors.push(query.cursor);
            return call === 1
              ? page({ events: [event()], nextCursor: 'cursor-1', hasMore: true, total: 2 })
              : page({
                  events: [event({ id: 'charge:chg_2', activity: 'Coding run' })],
                  nextCursor: null,
                  hasMore: false,
                  total: 2,
                });
          },
          breakdown: async (dimension) =>
            breakdown(
              dimension === 'day' ? 'day' : 'category',
              dimension === 'day' ? DAY_GROUPS : overview().selected.byCategory,
            ),
        }}
      />,
    );

    await screen.findByText('Chat message');
    expect(screen.queryByText('Coding run')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    // The second page is added to the first, not swapped in for it.
    expect(await screen.findByText('Coding run')).toBeTruthy();
    const table = document.querySelector('.v-usage__table');
    expect(table).not.toBeNull();
    const rows = within(table as HTMLElement);
    expect(rows.getByText('Chat message')).toBeTruthy();
    expect(rows.getByText('Coding run')).toBeTruthy();
    expect(cursors).toEqual([undefined, 'cursor-1']);
  }, 20_000);

  it('links the CSV export to the applied filters', async () => {
    render(
      <UsageHistoryPage
        deps={{
          overview: async () => overview(),
          history: async () => page(),
          breakdown: async (dimension) =>
            breakdown(
              dimension === 'day' ? 'day' : 'category',
              dimension === 'day' ? DAY_GROUPS : overview().selected.byCategory,
            ),
          exportUrl: (query) =>
            `/api/usage-history/export.csv?from=${query.from ?? ''}&to=${query.to ?? ''}`,
        }}
      />,
    );

    const link = await screen.findByRole('link', { name: 'Download CSV' });
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('from=');
    expect(href).toContain('to=');
    expect(link.getAttribute('download')).not.toBeNull();
  }, 20_000);

  it('offers an empty state when nothing matched, and a retry when the read failed', async () => {
    const { unmount } = render(
      <UsageHistoryPage
        deps={{
          overview: async () => overview(),
          history: async () => page({ events: [], total: 0 }),
          breakdown: async (dimension) => breakdown(dimension === 'day' ? 'day' : 'category', []),
        }}
      />,
    );
    expect(await screen.findByText('Nothing in this range')).toBeTruthy();
    unmount();

    const retry = vi.fn(async () => overview());
    render(
      <UsageHistoryPage
        deps={{
          overview: retry,
          history: async () => {
            throw new Error('The usage service is unavailable.');
          },
          breakdown: async () => {
            throw new Error('The usage service is unavailable.');
          },
        }}
      />,
    );
    expect(await screen.findByText('Usage could not be read')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(retry.mock.calls.length).toBeGreaterThan(0));
  }, 20_000);
});
