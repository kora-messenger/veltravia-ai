// @vitest-environment jsdom
/**
 * The plan screen (Step 60).
 *
 * The assertions follow what the page promises a person, not how it draws:
 *
 *  - a lapsed paid period reads as the included allowance, not as the old plan;
 *  - a feature the plan does not state is written as "Not included", and no
 *    price is invented anywhere on the page;
 *  - a change is only claimed after the server confirms it;
 *  - a failed change says what failed and leaves the screen usable;
 *  - offline is its own state, because "try again" is the wrong advice for a
 *    device with no connection.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, TransportError } from '../../api/client';
import type { SubscriptionOverview } from '../../api/subscriptions';
import { SubscriptionPlanPage } from './SubscriptionPlanPage';

afterEach(cleanup);

const plan = (
  id: string,
  name: string,
  overrides: Partial<SubscriptionOverview['plans'][number]> = {},
): SubscriptionOverview['plans'][number] => ({
  id,
  name,
  description: `${name} description`,
  rank: 1,
  active: true,
  visible: true,
  selfService: true,
  builtIn: false,
  monthlyMessageCredits: 300,
  monthlyIntegrationCredits: 10_000,
  entitlements: { managedProviders: true, byokProviders: true, codingAgent: true },
  quotas: { concurrentJobs: 16, fileStorageBytes: 1_073_741_824 },
  ...overrides,
});

function overview(overrides: Partial<SubscriptionOverview> = {}): SubscriptionOverview {
  const current = plan('builder', 'Builder');
  return {
    status: 'active',
    subscription: {
      id: 'sub_1',
      planId: 'builder',
      status: 'active',
      startedAt: '2026-11-01T00:00:00.000Z',
      currentPeriodStart: '2026-11-01T00:00:00.000Z',
      currentPeriodEnd: '2026-12-01T00:00:00.000Z',
      renews: true,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      suspendedAt: null,
      suspensionReason: null,
      expiredAt: null,
      version: 4,
    },
    effective: {
      source: 'subscription',
      plan: current,
      status: 'active',
      entitled: true,
      reason: null,
      daysRemaining: 18,
      renewalDue: false,
    },
    plans: [plan('development', 'Included'), current, plan('pro', 'Pro')],
    periods: [],
    events: [],
    allowances: { messageCredits: 300, integrationCredits: 10_000 },
    entitlements: current.entitlements,
    quotas: current.quotas,
    durable: true,
    selfService: {
      enabled: false,
      note: 'Plan changes are made by an operator until checkout exists.',
    },
    message: null,
    integrations: null,
    wallet: null,
    ...overrides,
  };
}

/**
 * The current plan's name is the page's only level-2 heading. The comparison
 * cards repeat the same names, so every "which plan am I on" assertion goes
 * through this and not through a bare text match.
 */
async function currentPlanName(name: string): Promise<void> {
  await screen.findByRole('heading', { level: 2, name });
}

describe('SubscriptionPlanPage', () => {
  it('shows the plan in force and its allowance', async () => {
    render(<SubscriptionPlanPage deps={{ overview: async () => overview() }} />);

    await currentPlanName('Builder');
    expect(screen.getByText('10,000')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('never prints a price, because there is no checkout', async () => {
    render(<SubscriptionPlanPage deps={{ overview: async () => overview() }} />);
    await currentPlanName('Builder');

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/[$£€]\s?\d/);
    expect(text).not.toMatch(/\bper month\b/i);
    expect(screen.getByText(/no prices are shown/i)).toBeTruthy();
  });

  it('says what a plan does not include rather than hiding it', async () => {
    render(
      <SubscriptionPlanPage
        deps={{
          overview: async () =>
            overview({
              entitlements: { managedProviders: true },
            }),
        }}
      />,
    );
    await currentPlanName('Builder');

    // Every declared feature is listed, and the absent ones read as absent.
    expect(screen.getByText('Managed AI models')).toBeTruthy();
    const coding = screen.getByText('Coding agent');
    const row = coding.closest('li');
    expect(row?.getAttribute('data-included')).toBe('false');
    expect(row?.textContent).toContain('Not included');
  });

  it('reads a lapsed period as the included allowance', async () => {
    render(
      <SubscriptionPlanPage
        deps={{
          overview: async () =>
            overview({
              status: 'expired',
              effective: {
                source: 'lapsed',
                plan: plan('development', 'Included', { monthlyIntegrationCredits: 500 }),
                status: 'expired',
                entitled: true,
                reason: 'Nothing was deleted. Your projects and credits are untouched.',
                daysRemaining: 0,
                renewalDue: false,
              },
              allowances: { messageCredits: 100, integrationCredits: 500 },
            }),
        }}
      />,
    );

    await currentPlanName('Included');
    expect(screen.getByText(/Paid period ended/i)).toBeTruthy();
    expect(screen.getByText(/Nothing was deleted/i)).toBeTruthy();
  });

  it('explains a suspension instead of offering features', async () => {
    render(
      <SubscriptionPlanPage
        deps={{
          overview: async () =>
            overview({
              status: 'suspended',
              effective: {
                source: 'suspended',
                plan: plan('builder', 'Builder'),
                status: 'suspended',
                entitled: false,
                reason: 'Chargeback under review',
                daysRemaining: 0,
                renewalDue: false,
              },
            }),
        }}
      />,
    );

    expect(await screen.findByText('Suspended')).toBeTruthy();
    await currentPlanName('Builder');
    expect(screen.getAllByText(/Chargeback under review/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Stop renewing')).toBeNull();
  });

  it('claims a change only after the server confirms it', async () => {
    const changePlan = vi.fn(async () => ({ direction: 'upgrade' }));
    const read = vi.fn(async () => overview({ selfService: { enabled: true, note: null } }));
    render(<SubscriptionPlanPage deps={{ overview: read, changePlan }} />);
    await currentPlanName('Builder');

    fireEvent.click(screen.getByRole('button', { name: /Move to Pro/i }));

    await waitFor(() => {
      expect(screen.getByText(/Your plan was changed to Pro/i)).toBeTruthy();
    });
    expect(changePlan).toHaveBeenCalledWith('pro', 4);
    // The screen re-reads the plan rather than assuming what it now is.
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reports a refused change and stays usable', async () => {
    const changePlan = vi.fn(async () => {
      throw new ApiError(
        409,
        'SUBSCRIPTION_CONFLICT',
        'This plan was changed elsewhere. Reload it.',
      );
    });
    render(
      <SubscriptionPlanPage
        deps={{
          overview: async () => overview({ selfService: { enabled: true, note: null } }),
          changePlan,
        }}
      />,
    );
    await currentPlanName('Builder');

    fireEvent.click(screen.getByRole('button', { name: /Move to Pro/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('changed elsewhere');
    });
    expect(screen.getByRole('button', { name: /Move to Pro/i })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Move to Pro/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('tells an operator-only account why the buttons do nothing', async () => {
    render(<SubscriptionPlanPage deps={{ overview: async () => overview() }} />);
    await currentPlanName('Builder');

    // Nothing is offered as a one-click change while self-service is closed.
    const buttons = screen.getAllByRole('button', { name: /Operator only/i });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(screen.queryByRole('button', { name: /Move to Pro/i })).toBeNull();
    expect(screen.getAllByText(/operator makes plan changes/i).length).toBeGreaterThan(0);
  });

  it('offers stop-renewing only while the plan will renew', async () => {
    const cancel = vi.fn(async () => ({}));
    render(
      <SubscriptionPlanPage
        deps={{
          overview: async () => overview({ selfService: { enabled: true, note: null } }),
          cancel,
        }}
      />,
    );
    await currentPlanName('Builder');

    fireEvent.click(screen.getByRole('button', { name: /Stop renewing/i }));
    await waitFor(() => {
      expect(screen.getByText(/will not renew/i)).toBeTruthy();
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('separates offline from a server failure', async () => {
    render(
      <SubscriptionPlanPage
        deps={{
          overview: async () => {
            throw new TransportError('offline', 'You are offline.');
          },
        }}
      />,
    );
    expect(await screen.findByText(/You are offline/i)).toBeTruthy();
  });

  it('offers a retry when the read fails for another reason', async () => {
    let calls = 0;
    render(
      <SubscriptionPlanPage
        deps={{
          overview: async () => {
            calls += 1;
            if (calls === 1) throw new ApiError(503, 'SUBSCRIPTIONS_UNAVAILABLE', 'Try later.');
            return overview();
          },
        }}
      />,
    );

    expect(await screen.findByText(/Your plan could not be read/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    await currentPlanName('Builder');
  });

  it('says the plan is not durable on a deployment with no database', async () => {
    render(<SubscriptionPlanPage deps={{ overview: async () => overview({ durable: false }) }} />);
    expect(await screen.findByText(/no database attached/i)).toBeTruthy();
  });
});
