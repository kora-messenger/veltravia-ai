// @vitest-environment jsdom
/**
 * The billing screen (Step 61).
 *
 * The assertions follow what the page promises a person, not how it draws:
 *
 *  - every amount on the screen came from the server, and there is no price when
 *    the server has none;
 *  - the checkout body carries a plan, an interval, a provider and an email, and
 *    nothing that could change the amount;
 *  - a return from the provider is confirmed with the server before any success is
 *    claimed, and a mismatch is reported as a refusal;
 *  - offline is its own state, because "try again" is wrong advice for a device
 *    with no connection.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, TransportError } from '../../api/client';
import type { BillingOverview, CheckoutView, QuoteView, SettleView } from '../../api/payments';
import { BillingPage } from './BillingPage';

afterEach(cleanup);

function overview(overrides: Partial<BillingOverview> = {}): BillingOverview {
  return {
    plan: {
      id: 'development',
      name: 'Development',
      status: 'active',
      entitled: true,
      interval: null,
      currentPeriodEnd: null,
      renews: false,
      cancelAtPeriodEnd: false,
      daysRemaining: 0,
    },
    subscription: {
      status: 'none',
      source: 'included',
      reason: null,
      monthlyMessageCredits: 2000,
      monthlyIntegrationCredits: 2000,
    },
    prices: [
      {
        planId: 'builder',
        planName: 'Builder',
        currency: 'NGN',
        monthly: 1_500_000,
        yearly: 15_000_000,
        yearlySavingPercent: 17,
      },
    ],
    providers: [
      {
        provider: 'paystack',
        displayName: 'Paystack',
        enabled: true,
        mode: 'test',
        configured: true,
        publicKey: null,
        currencies: ['NGN'],
        capabilities: {
          recurring: true,
          hostedCheckout: true,
          refunds: true,
          partialRefunds: true,
          webhooks: true,
        },
      },
    ],
    paymentMethod: null,
    transactions: [],
    invoices: [],
    refunds: [],
    notifications: [],
    policies: {
      refund: { policy: 'none', note: 'The paid period is untouched.' },
      grace: { days: 7, reminderDays: 3 },
      taxConfigured: false,
      topUps: false,
    },
    customer: { email: 'buyer@example.com', name: 'Test Buyer' },
    durable: true,
    note: 'Credits are a ceiling the plan grants.',
    ...overrides,
  };
}

const quoteView = (overrides: Partial<QuoteView> = {}): QuoteView => ({
  planId: 'builder',
  planName: 'Builder',
  interval: 'monthly',
  currency: 'NGN',
  unitAmountMinor: 1_500_000,
  discountMinor: 0,
  discountCode: null,
  subtotalMinor: 1_500_000,
  taxName: null,
  taxRateBps: 0,
  taxMinor: 0,
  totalMinor: 1_500_000,
  formatted: '15,000.00 NGN',
  providers: [
    {
      provider: 'paystack',
      displayName: 'Paystack',
      enabled: true,
      mode: 'test',
      configured: true,
      publicKey: null,
      currencies: ['NGN'],
      capabilities: {
        recurring: true,
        hostedCheckout: true,
        refunds: true,
        partialRefunds: true,
        webhooks: true,
      },
    },
  ],
  note: 'The amount is decided by this server from the configured rows.',
  ...overrides,
});

const checkout = (overrides: Partial<CheckoutView> = {}): CheckoutView => ({
  intentId: 'pi_1',
  reference: 'vtv_1',
  checkoutUrl: 'https://checkout.paystack.test/vtv_1',
  provider: 'paystack',
  mode: 'test',
  amountMinor: 1_500_000,
  currency: 'NGN',
  expiresAt: '2026-11-14T09:00:00.000Z',
  ...overrides,
});

const settled = (overrides: Partial<SettleView> = {}): SettleView => ({
  status: 'paid',
  reference: 'vtv_1',
  planId: 'builder',
  reason: null,
  transaction: null,
  invoice: null,
  ...overrides,
});

describe('current plan', () => {
  it('states the plan in force and what it includes', async () => {
    render(
      <BillingPage
        load={async () => overview()}
        quote={async () => quoteView()}
        readReference={() => null}
      />,
    );
    await waitFor(() => expect(screen.getByText('Development')).toBeTruthy());
    expect(screen.getByText(/2,000 AI credits/)).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
  });

  it('says so when nothing is priced instead of inventing a price', async () => {
    render(
      <BillingPage
        load={async () => overview({ prices: [] })}
        quote={async () => quoteView()}
        readReference={() => null}
      />,
    );
    await waitFor(() => expect(screen.getByText('No plan is priced yet')).toBeTruthy());
    expect(screen.queryByText(/NGN/)).toBeNull();
  });
});

describe('checkout', () => {
  it('shows the server quote and sends only the choice', async () => {
    const checkoutSpy = vi.fn(async () => checkout());
    const redirect = vi.fn();
    const quoteSpy = vi.fn(async () => quoteView());

    render(
      <BillingPage
        load={async () => overview()}
        quote={quoteSpy}
        checkout={checkoutSpy}
        redirect={redirect}
        readReference={() => null}
      />,
    );

    await waitFor(() => expect(screen.getByText('Continue to payment')).toBeTruthy());
    fireEvent.click(screen.getByText('Continue to payment'));

    await waitFor(() => expect(checkoutSpy).toHaveBeenCalledTimes(1));
    const sent = checkoutSpy.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(sent.planId).toBe('builder');
    expect(sent.interval).toBe('monthly');
    expect(sent.provider).toBe('paystack');
    expect(sent.email).toBe('buyer@example.com');
    // Nothing that could change what is charged travels from the browser.
    expect(sent.amountMinor).toBeUndefined();
    expect(sent.totalMinor).toBeUndefined();
    expect(sent.currency).toBeUndefined();
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith('https://checkout.paystack.test/vtv_1'),
    );
  });

  it('will not start a checkout without an email', async () => {
    const checkoutSpy = vi.fn(async () => checkout());
    render(
      <BillingPage
        load={async () => overview({ customer: null })}
        quote={async () => quoteView()}
        checkout={checkoutSpy}
        redirect={() => undefined}
        readReference={() => null}
      />,
    );
    await waitFor(() => expect(screen.getByText('Continue to payment')).toBeTruthy());
    fireEvent.click(screen.getByText('Continue to payment'));
    await waitFor(() => expect(screen.getByText('A receipt needs an email address.')).toBeTruthy());
    expect(checkoutSpy).not.toHaveBeenCalled();
  });

  it('re-asks for a quote when the interval changes', async () => {
    const quoteSpy = vi.fn(async (input: { interval: 'monthly' | 'yearly' }) =>
      quoteView({
        interval: input.interval,
        formatted: input.interval === 'yearly' ? '150,000.00 NGN' : '15,000.00 NGN',
      }),
    );
    render(
      <BillingPage
        load={async () => overview()}
        quote={quoteSpy}
        checkout={async () => checkout()}
        redirect={() => undefined}
        readReference={() => null}
      />,
    );
    await waitFor(() => expect(screen.getByText('15,000.00 NGN')).toBeTruthy());
    fireEvent.click(screen.getByText('Yearly'));
    await waitFor(() => expect(screen.getByText('150,000.00 NGN')).toBeTruthy());
    expect(
      quoteSpy.mock.calls.some(([input]) => (input as { interval: string }).interval === 'yearly'),
    ).toBe(true);
  });

  it('says there is no payment method rather than offering a dead button', async () => {
    render(
      <BillingPage
        load={async () => overview()}
        quote={async () => quoteView({ providers: [] })}
        readReference={() => null}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/No payment method is available for this currency/)).toBeTruthy(),
    );
    expect(screen.queryByText('Continue to payment')).toBeNull();
  });
});

describe('returning from the provider', () => {
  it('confirms the reference with the server before claiming success', async () => {
    const confirmSpy = vi.fn(async () => settled());
    render(
      <BillingPage
        load={async () => overview()}
        quote={async () => quoteView()}
        confirm={confirmSpy}
        readReference={() => 'vtv_1'}
      />,
    );
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith('vtv_1'));
    await waitFor(() => expect(screen.getByText('Payment received')).toBeTruthy());
    expect(screen.getByText(/is active/)).toBeTruthy();
  });

  it('reports a mismatch as a refusal, not a success', async () => {
    render(
      <BillingPage
        load={async () => overview()}
        quote={async () => quoteView()}
        confirm={async () =>
          settled({
            status: 'mismatch',
            planId: null,
            reason: 'The amount or currency did not match this order.',
          })
        }
        readReference={() => 'vtv_1'}
      />,
    );
    await waitFor(() => expect(screen.getByText('Payment not completed')).toBeTruthy());
    expect(screen.getByText(/does not match this order/)).toBeTruthy();
  });

  it('does not confirm anything when there is no reference in the address', async () => {
    const confirmSpy = vi.fn(async () => settled());
    render(
      <BillingPage
        load={async () => overview()}
        quote={async () => quoteView()}
        confirm={confirmSpy}
        readReference={() => null}
      />,
    );
    await waitFor(() => expect(screen.getByText('Development')).toBeTruthy());
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe('history', () => {
  it('lists payments with their amount and status', async () => {
    render(
      <BillingPage
        load={async () =>
          overview({
            transactions: [
              {
                id: 'tx_1',
                provider: 'paystack',
                providerReference: 'vtv_1',
                amountMinor: 1_500_000,
                currency: 'NGN',
                status: 'succeeded',
                kind: 'initial',
                planId: 'builder',
                interval: 'monthly',
                verifiedAt: '2026-11-14T08:05:00.000Z',
                failureReason: null,
                createdAt: '2026-11-14T08:04:00.000Z',
              },
            ],
          })
        }
        quote={async () => quoteView()}
        readReference={() => null}
      />,
    );
    await waitFor(() => expect(screen.getByText('succeeded')).toBeTruthy());
    expect(screen.getAllByText('15,000.00 NGN').length).toBeGreaterThan(0);
    expect(screen.getByText('builder · monthly')).toBeTruthy();
  });

  it('offers an invoice and a receipt for each paid document', async () => {
    render(
      <BillingPage
        load={async () =>
          overview({
            invoices: [
              {
                id: 'inv_1',
                number: 'INV-2026-000001',
                planName: 'Builder',
                interval: 'monthly',
                currency: 'NGN',
                unitAmountMinor: 1_500_000,
                discountMinor: 0,
                subtotalMinor: 1_500_000,
                taxName: null,
                taxRateBps: 0,
                taxMinor: 0,
                totalMinor: 1_500_000,
                status: 'paid',
                issuedAt: '2026-11-14T08:05:00.000Z',
                paidAt: '2026-11-14T08:05:00.000Z',
                transactionReference: 'vtv_1',
                provider: 'paystack',
                customerEmail: 'buyer@example.com',
              },
            ],
          })
        }
        quote={async () => quoteView()}
        invoiceUrl={(id, kind) => `https://api.test/invoices/${id}/${kind}.pdf`}
        readReference={() => null}
      />,
    );
    await waitFor(() => expect(screen.getByText('INV-2026-000001')).toBeTruthy());
    const invoice = screen.getByText('Invoice PDF') as HTMLAnchorElement;
    const receipt = screen.getByText('Receipt PDF') as HTMLAnchorElement;
    expect(invoice.getAttribute('href')).toContain('/invoice.pdf');
    expect(receipt.getAttribute('href')).toContain('/receipt.pdf');
    expect(receipt.hasAttribute('download')).toBe(true);
  });

  it('says the history is empty rather than drawing an empty table', async () => {
    render(
      <BillingPage
        load={async () => overview()}
        quote={async () => quoteView()}
        readReference={() => null}
      />,
    );
    await waitFor(() => expect(screen.getByText('No payments yet')).toBeTruthy());
    expect(screen.getByText('No invoices yet')).toBeTruthy();
  });
});

describe('failure states', () => {
  it('shows an offline state without advice to retry the network', async () => {
    render(
      <BillingPage
        load={async () => {
          throw new TransportError('offline', 'You are offline.');
        }}
        readReference={() => null}
      />,
    );
    await waitFor(() => expect(screen.getByText('You are offline')).toBeTruthy());
    expect(screen.getByText(/Nothing was charged/)).toBeTruthy();
  });

  it('reports a refusal and keeps the screen usable', async () => {
    render(
      <BillingPage
        load={async () => overview()}
        quote={async () => quoteView()}
        checkout={async () => {
          throw new ApiError(409, 'PLAN_UNAVAILABLE', 'That plan is not available.');
        }}
        redirect={() => undefined}
        readReference={() => null}
      />,
    );
    await waitFor(() => expect(screen.getByText('Continue to payment')).toBeTruthy());
    fireEvent.click(screen.getByText('Continue to payment'));
    await waitFor(() => expect(screen.getByText('That plan is not available.')).toBeTruthy());
    expect(screen.getByText('Development')).toBeTruthy();
  });
});
