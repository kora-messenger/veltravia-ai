// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WalletPanel } from './WalletPanel';
import type { WalletCapabilities, WalletEntryView, WalletOverviewView } from '../../api/wallet';

/**
 * The wallet panel (Step 53).
 *
 * The assertions that matter are the honest ones: held credit is never presented
 * as spendable, a charge shows what it was for and at what rate, an empty wallet
 * says how usage will appear instead of looking broken, and the panel offers no
 * way for a user to give themselves credit.
 */

const api = vi.hoisted(() => ({
  getWalletOverview: vi.fn(),
  getWalletCapabilities: vi.fn(),
  listWalletTransactions: vi.fn(),
  reconcileWallet: vi.fn(),
}));

vi.mock('../../api/wallet', () => api);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const entry = (
  over: Partial<WalletEntryView> & Pick<WalletEntryView, 'kind'>,
): WalletEntryView => ({
  id: `wle_${over.kind}`,
  seq: 1,
  amount: 5,
  availableDelta: -5,
  reservedDelta: 0,
  spentDelta: 5,
  balanceAfter: 95,
  reason: 'background_jobs 1 calls at 5 credits per 1 (veltravia-credits-2026-11).',
  actor: 'usage-meter',
  occurredAt: '2026-11-08T10:00:00.000Z',
  referenceType: 'usage_record',
  referenceId: 'job:abc',
  ...over,
});

const overview = (over: Partial<WalletOverviewView> = {}): WalletOverviewView => ({
  durable: true,
  wallet: {
    id: 'walu_1',
    scope: 'user',
    workspaceId: null,
    unit: 'credits',
    available: 100,
    reserved: 20,
    spent: 5,
    spendable: 80,
    currency: 'VELTRAVIA_CREDITS',
    policy: { allowNegative: false, negativeFloor: 0 },
    updatedAt: '2026-11-08T10:00:00.000Z',
  },
  held: [
    {
      id: 'wlr_1',
      amount: 20,
      state: 'held',
      operationKey: 'worker:wkr_1:run',
      expiresAt: '2026-11-08T11:00:00.000Z',
      createdAt: '2026-11-08T10:00:00.000Z',
    },
  ],
  recent: [],
  rates: {
    version: 'veltravia-credits-2026-11',
    rates: ['background_jobs: 5 credits per 1 calls'],
    note: 'Documented defaults.',
  },
  note: 'Balances are stored in the database and survive a restart.',
  ...over,
});

const capabilities: WalletCapabilities = {
  durable: true,
  currency: 'VELTRAVIA_CREDITS',
  unit: 'credits',
  rateVersion: 'veltravia-credits-2026-11',
  rates: ['background_jobs: 5 credits per 1 calls', 'file_storage: not billed'],
  rules: [
    'A metered event is charged once. The charge is keyed on the meter’s own operation key, so a retried worker or a replayed request cannot be billed twice.',
    'Usage paid for with your own provider key is never converted into Veltravia credits.',
  ],
  limits: ['Wallets are per owner and per workspace.'],
};

function prime(
  options: {
    readonly view?: WalletOverviewView;
    readonly entries?: readonly WalletEntryView[];
  } = {},
): void {
  api.getWalletOverview.mockResolvedValue(options.view ?? overview());
  api.getWalletCapabilities.mockResolvedValue(capabilities);
  api.listWalletTransactions.mockResolvedValue({
    transactions: options.entries ?? [entry({ kind: 'usage_deduction' })],
    nextBefore: 1,
  });
}

describe('wallet panel', () => {
  it('separates held credit from spendable credit', async () => {
    prime();
    render(<WalletPanel />);

    await waitFor(() => expect(screen.getByText('Available')).toBeTruthy());
    expect(screen.getByText('Held')).toBeTruthy();
    expect(screen.getByText('Spendable now')).toBeTruthy();
    // 80 is spendable, 100 is available: both are on screen and labelled apart.
    expect(screen.getByText('80')).toBeTruthy();
    expect(screen.getByText('100')).toBeTruthy();
    expect(screen.getByText(/Not spent, not spendable/)).toBeTruthy();
  });

  it('lists an in-flight hold with what it was taken for', async () => {
    prime();
    render(<WalletPanel />);
    await waitFor(() => expect(screen.getByText('Held for work in flight')).toBeTruthy());
    expect(screen.getByText('worker:wkr_1:run')).toBeTruthy();
  });

  it('shows a usage charge with its reason and the rate table', async () => {
    prime();
    render(<WalletPanel />);

    await waitFor(() => expect(screen.getByText('Usage charge')).toBeTruthy());
    expect(screen.getByText(/5 credits per 1/)).toBeTruthy();

    fireEvent.click(screen.getByText('How credits are charged'));
    expect(screen.getByText(/file_storage: not billed/)).toBeTruthy();
    expect(screen.getByText(/never converted into Veltravia credits/)).toBeTruthy();
    // The reasoning is visible, not just the number.
    expect(screen.getByText(/cannot be billed twice/)).toBeTruthy();
  });

  it('says an empty wallet is empty rather than broken', async () => {
    prime({
      view: overview({
        wallet: {
          ...overview().wallet,
          available: 0,
          reserved: 0,
          spent: 0,
          spendable: 0,
        },
        held: [],
      }),
      entries: [],
    });
    render(<WalletPanel />);
    await waitFor(() =>
      expect(screen.getByText(/Nothing has moved in this wallet yet/)).toBeTruthy(),
    );
  });

  it('offers no way to add credit from the dashboard', async () => {
    prime();
    render(<WalletPanel />);
    await waitFor(() => expect(screen.getByText('Credit wallet')).toBeTruthy());
    const buttons = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    expect(buttons.join(' ')).not.toMatch(/add credit|top up|buy credits|grant/i);
  });

  it('reports a consistent reconciliation in plain words', async () => {
    prime();
    api.reconcileWallet.mockResolvedValue({
      walletId: 'walu_1',
      consistent: true,
      entries: 3,
      ledger: { available: 100, reserved: 20, spent: 5 },
      stored: { available: 100, reserved: 20, spent: 5 },
      problems: [],
    });
    render(<WalletPanel />);
    await waitFor(() => expect(screen.getByText('Check balances against the ledger')).toBeTruthy());
    fireEvent.click(screen.getByText('Check balances against the ledger'));
    await waitFor(() => expect(screen.getByText(/Consistent across 3 entries/)).toBeTruthy());
  });

  it('surfaces a divergent wallet instead of hiding it', async () => {
    prime();
    api.reconcileWallet.mockResolvedValue({
      walletId: 'walu_1',
      consistent: false,
      entries: 3,
      ledger: { available: 90, reserved: 20, spent: 5 },
      stored: { available: 100, reserved: 20, spent: 5 },
      problems: ['available is stored as 100 but the ledger adds up to 90'],
    });
    render(<WalletPanel />);
    await waitFor(() => expect(screen.getByText('Check balances against the ledger')).toBeTruthy());
    fireEvent.click(screen.getByText('Check balances against the ledger'));
    await waitFor(() =>
      expect(
        screen.getByText(/available is stored as 100 but the ledger adds up to 90/),
      ).toBeTruthy(),
    );
  });

  it('marks a non-durable wallet as in memory', async () => {
    prime({ view: overview({ durable: false }) });
    render(<WalletPanel />);
    await waitFor(() => expect(screen.getByText('In memory only')).toBeTruthy());
  });
});
