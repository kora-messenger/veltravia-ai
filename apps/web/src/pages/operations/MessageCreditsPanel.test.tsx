// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageCreditsPanel } from './MessageCreditsPanel';
import type {
  MessageChargeView,
  MessageCreditPolicyView,
  MessageCreditSummary,
} from '../../api/message-credits';

/**
 * The message-credit panel (Step 54).
 *
 * The assertions are about honesty rather than layout: shipped rates must be
 * called defaults, held credit must be visible beside the balance instead of
 * being folded into it, and an empty account must be warned about plainly.
 */

const api = vi.hoisted(() => ({
  getMessageCreditSummary: vi.fn(),
  getMessageCreditPolicy: vi.fn(),
  listMessageCharges: vi.fn(),
  getMessageUsage: vi.fn(),
  getMessageCreditIntegrity: vi.fn(),
}));

vi.mock('../../api/message-credits', () => api);

vi.mock('../../components/ui', async () => {
  const actual = await vi.importActual<typeof import('../../components/ui')>('../../components/ui');
  return { ...actual };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function summary(over: Partial<MessageCreditSummary> = {}): MessageCreditSummary {
  return {
    wallet: { available: 24, reserved: 6, spent: 70, spendable: 18 },
    month: {
      charges: 12,
      credits: 70,
      refunded: 3,
      open: 1,
      byKind: [{ key: 'chat.message', charges: 10, credits: 60 }],
    },
    openReservations: [
      {
        chargeId: 'mch_one',
        kind: 'chat.message',
        estimatedCredits: 6,
        conversationId: 'conv-alpha',
        createdAt: '2026-11-09T10:00:00.000Z',
      },
    ],
    settings: { monthlyLimit: 100, perRequestLimit: 5 },
    ...over,
  };
}

const policy: MessageCreditPolicyView = {
  version: 'message-rates.v1',
  currency: 'credits',
  defaultsOnly: true,
  note: 'Configurable defaults, not market prices.',
  plans: [
    {
      planId: 'paid',
      billable: true,
      interactions: [
        {
          kind: 'chat.message',
          policyId: 'paid.chat',
          flatCredits: 1,
          per1kInput: 0.2,
          per1kOutput: 0.6,
          per1kCached: 0.05,
          perToolCall: 0.1,
          chargeByok: true,
          enabled: true,
        },
      ],
    },
  ],
};

function charge(over: Partial<MessageChargeView> = {}): MessageChargeView {
  return {
    id: 'mch_one',
    kind: 'chat.message',
    state: 'committed',
    credits: 1,
    estimatedCredits: 1,
    basis: 'flat',
    planId: 'paid',
    policyId: 'paid.chat',
    modelId: 'openai/gpt-4o-mini',
    providerId: 'openrouter',
    projectId: null,
    conversationId: 'conv-alpha',
    runId: 'run_1',
    inputTokens: 900,
    outputTokens: 300,
    cachedTokens: null,
    durationMs: 2100,
    toolCalls: null,
    byok: true,
    limitations: ['byok-tokens-excluded'],
    createdAt: '2026-11-09T10:00:00.000Z',
    settledAt: '2026-11-09T10:00:03.000Z',
    refundedAt: null,
    failureReason: null,
    ...over,
  };
}

function prime(
  over: {
    summary?: Partial<MessageCreditSummary>;
    charges?: readonly MessageChargeView[];
    groups?: {
      key: string;
      charges: number;
      credits: number;
      inputTokens: number;
      outputTokens: number;
    }[];
    consistent?: boolean;
  } = {},
): void {
  const charges = over.charges ?? [charge()];
  api.getMessageCreditSummary.mockResolvedValue(summary(over.summary));
  api.getMessageCreditPolicy.mockResolvedValue(policy);
  api.listMessageCharges.mockResolvedValue({ charges, total: charges.length });
  api.getMessageUsage.mockResolvedValue({
    dimension: 'model',
    groups: over.groups ?? [
      { key: 'openai/gpt-4o-mini', charges: 4, credits: 4, inputTokens: 3200, outputTokens: 900 },
    ],
  });
  api.getMessageCreditIntegrity.mockResolvedValue({
    consistent: over.consistent ?? true,
    walletDiscrepancies: [],
    chargesWithoutEntry: [],
  });
}

describe('the message-credit panel', () => {
  it('shows the balance with held credit kept separate from what is spendable', async () => {
    prime();
    render(<MessageCreditsPanel />);

    await waitFor(() => expect(screen.getByText('Message credits')).toBeTruthy());
    expect(screen.getByText('Available')).toBeTruthy();
    expect(screen.getByText('24 credits')).toBeTruthy();
    expect(screen.getByText('Held for work in flight')).toBeTruthy();
    expect(screen.getByText('6 credits')).toBeTruthy();
  });

  it('labels the shipped rate table as configurable defaults, not prices', async () => {
    prime();
    render(<MessageCreditsPanel />);

    await waitFor(() => expect(screen.getByText(/What a message costs/)).toBeTruthy());
    expect(screen.getByText(/shipped defaults/)).toBeTruthy();
    expect(screen.getByText(/not prices/)).toBeTruthy();
  });

  it('says a configured table is configuration rather than defaults', async () => {
    prime();
    api.getMessageCreditPolicy.mockResolvedValue({ ...policy, defaultsOnly: false });
    render(<MessageCreditsPanel />);

    await waitFor(() => expect(screen.getAllByText(/configuration/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/shipped defaults/)).toBeNull();
  });

  it('warns plainly when nothing is spendable', async () => {
    prime({
      summary: {
        wallet: { available: 0, reserved: 2, spent: 40, spendable: 0 },
        openReservations: [],
      },
    });
    render(<MessageCreditsPanel />);

    await waitFor(() => expect(screen.getByText(/No message credits are available/)).toBeTruthy());
    expect(screen.getByText(/nothing you typed is discarded/)).toBeTruthy();
  });

  it('does not warn when credit is available', async () => {
    prime();
    render(<MessageCreditsPanel />);

    await waitFor(() => expect(screen.getByText('Message credits')).toBeTruthy());
    expect(screen.queryByText(/No message credits are available/)).toBeNull();
  });

  it('names the model, the basis and what could not be measured on a charge', async () => {
    prime({ charges: [charge({ limitations: ['tokens-unavailable', 'output-tokens-missing'] })] });
    render(<MessageCreditsPanel />);

    await waitFor(() =>
      expect(screen.getAllByText('openai/gpt-4o-mini').length).toBeGreaterThan(0),
    );
    expect(screen.getByText(/tokens-unavailable/)).toBeTruthy();
    expect(screen.getByText('committed')).toBeTruthy();
    expect(screen.getByText(/conv-alpha/)).toBeTruthy();
  });

  it('switches the usage grouping when another dimension is chosen', async () => {
    prime();
    render(<MessageCreditsPanel />);

    await waitFor(() => expect(screen.getByText('By project')).toBeTruthy());
    api.getMessageUsage.mockResolvedValue({
      dimension: 'project',
      groups: [{ key: 'proj-one', charges: 2, credits: 2, inputTokens: 10, outputTokens: 5 }],
    });
    fireEvent.click(screen.getByText('By project'));

    await waitFor(() => expect(api.getMessageUsage).toHaveBeenLastCalledWith('project'));
    expect(await screen.findByText('proj-one')).toBeTruthy();
  });

  it('says when the ledger and the charges disagree', async () => {
    prime();
    api.getMessageCreditIntegrity.mockResolvedValue({
      consistent: false,
      walletDiscrepancies: ['wallet w-1'],
      chargesWithoutEntry: ['mch_orphan'],
    });
    render(<MessageCreditsPanel />);

    await waitFor(() => expect(screen.getByText(/Ledger disagreement/)).toBeTruthy());
    expect(screen.getByText(/mch_orphan/)).toBeTruthy();
  });

  it('offers a retry instead of a blank screen when the read fails', async () => {
    api.getMessageCreditSummary.mockRejectedValue(new Error('offline'));
    api.getMessageCreditPolicy.mockRejectedValue(new Error('offline'));
    api.listMessageCharges.mockRejectedValue(new Error('offline'));
    api.getMessageUsage.mockRejectedValue(new Error('offline'));
    api.getMessageCreditIntegrity.mockRejectedValue(new Error('offline'));
    render(<MessageCreditsPanel />);

    await waitFor(() =>
      expect(screen.getByText(/Message credits could not be loaded/)).toBeTruthy(),
    );
    expect(screen.getByText(/Nothing has been charged by this screen/)).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });
});
