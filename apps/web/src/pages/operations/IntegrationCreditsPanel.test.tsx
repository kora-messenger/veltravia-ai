// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IntegrationCreditsPanel } from './IntegrationCreditsPanel';
import type {
  IntegrationChargeView,
  IntegrationCreditPolicyView,
  IntegrationCreditSummary,
} from '../../api/integration-credits';

/**
 * The integration-credit panel (Step 56).
 *
 * The assertions are about the things that would mislead a person: the three
 * billing classes must stay apart, a hold must be visible as credit that is not
 * spendable, an unmeasured operation must say so, and the shipped rates must be
 * called defaults rather than prices.
 */

const api = vi.hoisted(() => ({
  getIntegrationCreditSummary: vi.fn(),
  getIntegrationCreditPolicy: vi.fn(),
  listIntegrationCharges: vi.fn(),
  getIntegrationUsage: vi.fn(),
  getIntegrationCreditIntegrity: vi.fn(),
  updateIntegrationCreditSettings: vi.fn(),
  classifyIntegrationOperation: vi.fn(),
}));

vi.mock('../../api/integration-credits', () => api);

vi.mock('../../components/ui', async () => {
  const actual = await vi.importActual<typeof import('../../components/ui')>('../../components/ui');
  return { ...actual };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function summary(over: Partial<IntegrationCreditSummary> = {}): IntegrationCreditSummary {
  return {
    wallet: { available: 18, reserved: 2.5, spent: 41, spendable: 15.5 },
    month: {
      charges: 4,
      credits: 3.2,
      refunded: 0.4,
      exempt: 9,
      open: 1,
      openCredits: 2.5,
      requests: 37,
      units: 400,
      byBillingClass: [{ key: 'paid', charges: 4, credits: 3.2, requests: 37, units: 400 }],
      byIntegration: [{ key: 'github', charges: 3, credits: 2.8, requests: 30, units: 0 }],
    },
    openHolds: [
      {
        chargeId: 'ich_open',
        integrationId: 'github',
        operationId: 'contents.get',
        executionId: 'run-7',
        estimatedCredits: 2.5,
        createdAt: '2026-11-12T05:00:00.000Z',
      },
    ],
    settings: { monthlyLimit: 50, perOperationLimit: null, updatedAt: null },
    ...over,
  };
}

const policy: IntegrationCreditPolicyView = {
  version: 'integration-rates.v1',
  defaultsOnly: true,
  note: 'Configurable defaults shipped with Veltravia, not market prices.',
  currency: 'credits',
  holdTtlSeconds: 900,
  classes: [
    { billingClass: 'free', label: 'Free', meaning: 'Costs nothing to run.' },
    {
      billingClass: 'paid',
      label: 'Paid',
      meaning: 'The platform provides the credential.',
    },
    {
      billingClass: 'externally-billed',
      label: 'Billed to your own account',
      meaning: 'The external service charges you directly.',
    },
  ],
  plans: [
    {
      planId: 'paid',
      label: 'Paid',
      billable: true,
      policies: [
        {
          id: 'paid:github:contents.get',
          label: 'Read repository content',
          kind: 'integration.operation',
          integrationId: 'github',
          operationId: 'contents.get',
          billingClass: 'paid',
          perOperation: 0.4,
          perRequest: 0.04,
          rates: [{ unit: 'record', creditsPerUnit: 0.001 }],
          chargeExternallyBilled: false,
          chargeByok: false,
        },
      ],
    },
  ],
};

function charge(over: Partial<IntegrationChargeView> = {}): IntegrationChargeView {
  return {
    id: 'ich_one',
    workspaceId: null,
    projectId: null,
    integrationId: 'github',
    connectorId: 'github',
    operationId: 'contents.get',
    executionId: 'run-9',
    requestId: 'inv-9',
    connectionId: 'conn-1',
    kind: 'integration.operation',
    billingClass: 'paid',
    planId: 'paid',
    policyId: 'paid:github:contents.get',
    credits: 0.44,
    estimatedCredits: 0.4,
    state: 'committed',
    basis: 'measured',
    requests: 1,
    units: {},
    durationMs: null,
    limitations: [],
    measurementSource: 'connector',
    byok: false,
    reservationId: 'wlr_1',
    walletEntryId: 'wle_1',
    failureReason: null,
    createdAt: '2026-11-12T05:00:00.000Z',
    settledAt: '2026-11-12T05:00:01.000Z',
    refundedAt: null,
    ...over,
  };
}

function mockAll(charges: readonly IntegrationChargeView[] = [charge()]): void {
  api.getIntegrationCreditSummary.mockResolvedValue(summary());
  api.getIntegrationCreditPolicy.mockResolvedValue(policy);
  api.listIntegrationCharges.mockResolvedValue({ charges, total: charges.length });
  api.getIntegrationUsage.mockResolvedValue({ dimension: 'integration', groups: [] });
  api.getIntegrationCreditIntegrity.mockResolvedValue({
    consistent: true,
    chargesWithoutEntry: 0,
    wallet: { consistent: true, discrepancies: [] },
  });
}

describe('IntegrationCreditsPanel', () => {
  it('separates held credit from spendable credit', async () => {
    mockAll();
    render(<IntegrationCreditsPanel />);
    expect(await screen.findByText('Held for operations in flight')).toBeTruthy();
    // The held balance is also the open-hold total, so the string appears twice.
    expect(screen.getAllByText('2.5 credits').length).toBeGreaterThan(0);
    // What is left to spend is the available figure; the hold is shown apart
    // from it rather than netted off, so both numbers are on screen.
    expect(screen.getByText('18 credits')).toBeTruthy();
    expect(screen.getByText(/1 operation in flight/)).toBeTruthy();
    // Once in the open-hold list, once in the charge table.
    expect(screen.getAllByText(/github · contents\.get/).length).toBeGreaterThan(0);
  });

  it('names the three billing classes instead of collapsing them', async () => {
    mockAll();
    render(<IntegrationCreditsPanel />);
    await screen.findByText('Who pays for an operation');
    expect(screen.getAllByText('Free').length).toBeGreaterThan(0);
    expect(screen.getByText('Billed to your own account')).toBeTruthy();
    expect(screen.getByText(/The external service charges you directly/)).toBeTruthy();
  });

  it('labels the shipped rates as configurable defaults', async () => {
    mockAll();
    render(<IntegrationCreditsPanel />);
    await screen.findByText('What an integration operation costs');
    expect(screen.getByText(/shipped defaults \(table integration-rates.v1\)/)).toBeTruthy();
    expect(screen.getByText(/not prices/)).toBeTruthy();
    expect(screen.getByText('0.001 / record')).toBeTruthy();
  });

  it('says an operation was not measured rather than showing a zero', async () => {
    mockAll([
      charge({ id: 'ich_blind', requests: null, limitations: ['request-count-unavailable'] }),
    ]);
    render(<IntegrationCreditsPanel />);
    expect(await screen.findByText('not reported')).toBeTruthy();
    expect(screen.getByText(/request-count-unavailable/)).toBeTruthy();
  });

  it('shows a BYOK row as exempt with its reason', async () => {
    mockAll([
      charge({
        id: 'ich_byok',
        state: 'exempt',
        credits: 0,
        byok: true,
        limitations: ['byok-excluded'],
      }),
    ]);
    render(<IntegrationCreditsPanel />);
    // 'exempt' is also a filter label, so the badge is one of several.
    expect((await screen.findAllByText('exempt')).length).toBeGreaterThan(0);
    expect(screen.getByText(/byok-excluded/)).toBeTruthy();
  });

  it('saves the spending limits and reports what was saved', async () => {
    mockAll();
    api.updateIntegrationCreditSettings.mockResolvedValue({
      monthlyLimit: 25,
      perOperationLimit: 1.5,
      updatedAt: '2026-11-12T06:00:00.000Z',
    });
    render(<IntegrationCreditsPanel />);
    const monthly = (await screen.findByLabelText('Monthly limit')) as HTMLInputElement;
    fireEvent.change(monthly, { target: { value: '25' } });
    const perOperation = screen.getByLabelText('Per operation') as HTMLInputElement;
    fireEvent.change(perOperation, { target: { value: '1.5' } });
    fireEvent.click(screen.getByText('Save limits'));
    await waitFor(() => expect(api.updateIntegrationCreditSettings).toHaveBeenCalledTimes(1));
    expect(api.updateIntegrationCreditSettings.mock.calls[0]?.[0]).toEqual({
      monthlyLimit: 25,
      perOperationLimit: 1.5,
    });
    expect(await screen.findByText(/Monthly limit: 25 credits/)).toBeTruthy();
  });

  it('clears a limit by sending no limit, not by sending zero', async () => {
    mockAll();
    api.updateIntegrationCreditSettings.mockResolvedValue({
      monthlyLimit: null,
      perOperationLimit: null,
      updatedAt: '2026-11-12T06:00:00.000Z',
    });
    render(<IntegrationCreditsPanel />);
    const monthly = (await screen.findByLabelText('Monthly limit')) as HTMLInputElement;
    fireEvent.change(monthly, { target: { value: '' } });
    fireEvent.click(screen.getByText('Save limits'));
    await waitFor(() => expect(api.updateIntegrationCreditSettings).toHaveBeenCalledTimes(1));
    expect(api.updateIntegrationCreditSettings.mock.calls[0]?.[0]).toEqual({
      monthlyLimit: null,
      perOperationLimit: null,
    });
    expect(await screen.findByText(/Monthly limit: none/)).toBeTruthy();
  });

  it('shows an honest error when the dashboard cannot load', async () => {
    api.getIntegrationCreditSummary.mockRejectedValue(new Error('offline'));
    api.getIntegrationCreditPolicy.mockResolvedValue(policy);
    api.listIntegrationCharges.mockResolvedValue({ charges: [], total: 0 });
    api.getIntegrationUsage.mockResolvedValue({ dimension: 'integration', groups: [] });
    api.getIntegrationCreditIntegrity.mockRejectedValue(new Error('offline'));
    render(<IntegrationCreditsPanel />);
    expect(
      await screen.findByText(
        'Integration credits could not be loaded. Nothing has been charged by this screen.',
      ),
    ).toBeTruthy();
  });
});
