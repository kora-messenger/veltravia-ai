import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  InMemoryPaymentStore,
  type PaymentTransport,
  type PaymentProviderId,
} from '@veltravia/payments-core';

import { buildApp } from './server.js';
import { createPaymentService, type PaymentService } from './payment-service.js';
import { createSubscriptionService } from './subscription-service.js';

/**
 * Payments (Step 61) over HTTP.
 *
 * The provider is a fixture, so nothing here reaches a network and no real money
 * moves. What the suite is actually proving:
 *
 *  - an amount cannot be supplied by the caller, only by the price rows;
 *  - a redirect is not proof, a verification is;
 *  - a webhook is proved by its signature and acted on once;
 *  - a reference is single-use, so a duplicate cannot buy a second period;
 *  - one workspace cannot read or pay another's billing;
 *  - a refund needs an explicit approval and cannot exceed what was charged.
 */

const OWNER = 'owner-one';
const OTHER = 'owner-two';
const ADMIN = 'admin-token-for-tests';

function planPrice(): { planId: string; amountMinor: number } {
  return { planId: 'builder', amountMinor: 1_500_000 };
}

interface Fixture {
  readonly transport: PaymentTransport;
  readonly calls: { url: string; body?: unknown }[];
  setVerify: (
    reference: string,
    state: { status?: string; amountMinor?: number; currency?: string },
  ) => void;
  charge: (input: { reference: string }) => { status: string; amountMinor: number };
}

/** A provider that answers initialize and verify from state the test controls. */
function providerFixture(): Fixture {
  const calls: { url: string; body?: unknown }[] = [];
  const verifications = new Map<
    string,
    { status: string; amountMinor: number; currency: string }
  >();
  const charges = new Map<string, { status: string; amountMinor: number }>();

  const transport: PaymentTransport = async (request) => {
    calls.push({
      url: request.url,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    if (request.url.includes('/transaction/initialize')) {
      const body = request.body as { reference?: string };
      return {
        status: 200,
        body: {
          status: true,
          data: {
            authorization_url: `https://checkout.paystack.test/${body.reference ?? ''}`,
            reference: body.reference ?? '',
          },
        },
        raw: '{}',
      };
    }
    if (request.url.includes('/transaction/verify/')) {
      const reference = decodeURIComponent(request.url.split('/transaction/verify/')[1] ?? '');
      const state = verifications.get(reference) ?? {
        status: 'success',
        amountMinor: 1_500_000,
        currency: 'NGN',
      };
      return {
        status: 200,
        body: {
          status: true,
          data: {
            status: state.status,
            reference,
            amount: state.amountMinor,
            currency: state.currency,
            channel: 'card',
            paid_at: '2026-11-14T08:05:00.000Z',
            authorization: {
              authorization_code: 'AUTH_fixture',
              reusable: true,
              brand: 'visa',
              last4: '4081',
              exp_month: '12',
              exp_year: '2030',
            },
          },
        },
        raw: '{}',
      };
    }
    if (request.url.includes('/transaction/charge_authorization')) {
      const body = request.body as { reference?: string };
      const state = charges.get(body.reference ?? '') ?? {
        status: 'success',
        amountMinor: 1_500_000,
      };
      return {
        status: 200,
        body: {
          status: true,
          data: {
            status: state.status,
            reference: body.reference,
            amount: state.amountMinor,
            currency: 'NGN',
            channel: 'card',
            paid_at: '2026-11-14T09:00:00.000Z',
          },
        },
        raw: '{}',
      };
    }
    if (request.url.includes('/refund')) {
      return {
        status: 200,
        body: { status: true, data: { id: 909, status: 'processed', amount: 1_451_250 } },
        raw: '{}',
      };
    }
    return { status: 404, body: { message: 'unexpected call' }, raw: '{}' };
  };

  return {
    transport,
    calls,
    setVerify(reference, state) {
      verifications.set(reference, {
        status: state.status ?? 'success',
        amountMinor: state.amountMinor ?? 1_500_000,
        currency: state.currency ?? 'NGN',
      });
    },
    charge(input) {
      const state = { status: 'success', amountMinor: 1_500_000 };
      charges.set(input.reference, state);
      return state;
    },
  };
}

interface Harness {
  readonly service: PaymentService;
  readonly subscriptions: ReturnType<typeof createSubscriptionService>;
  readonly store: InMemoryPaymentStore;
  readonly fixture: Fixture;
  /** Moves the clock both services read, so a renewal can be reached. */
  setNow(iso: string): void;
}

async function harness(options: { withMethod?: boolean } = {}): Promise<Harness> {
  const store = new InMemoryPaymentStore();
  const fixture = providerFixture();
  let clock = new Date('2026-11-14T08:00:00.000Z');
  const now = (): Date => clock;
  const subscriptions = createSubscriptionService({ now });
  await subscriptions.ensureCatalogue();
  const service = createPaymentService({
    store,
    subscriptions,
    transport: fixture.transport,
    readSecret: (name) =>
      name === 'PAYSTACK_SECRET_KEY'
        ? 'sk_test_fixture'
        : name === 'PAYSTACK_WEBHOOK_SECRET'
          ? 'whsec_fixture'
          : '',
    publicBaseUrl: 'https://app.veltravia.test',
    now,
  });
  await service.ensure();
  await service.configureProvider({
    provider: 'paystack',
    mode: 'test',
    enabled: true,
    actor: 'test',
  });
  await service.savePrice({
    actor: 'test',
    draft: {
      planId: planPrice().planId,
      interval: 'monthly',
      currency: 'NGN',
      amountMinor: planPrice().amountMinor,
    },
  });
  await service.savePrice({
    actor: 'test',
    draft: {
      planId: planPrice().planId,
      interval: 'yearly',
      currency: 'NGN',
      amountMinor: 15_000_000,
    },
  });
  if (options.withMethod === true) {
    await store.savePaymentMethod({
      id: 'pm_fixture',
      ownerRef: OWNER,
      provider: 'paystack',
      mode: 'test',
      authorizationCode: 'AUTH_fixture',
      brand: 'visa',
      last4: '4081',
      expMonth: '12',
      expYear: '2030',
      reusable: true,
      createdAt: '2026-11-14T08:00:00.000Z',
    });
  }
  return {
    service,
    subscriptions,
    store,
    fixture,
    setNow(iso) {
      clock = new Date(iso);
    },
  };
}

async function buy(
  h: Harness,
  ownerRef = OWNER,
  input: { discountCode?: string; email?: string } = {},
): Promise<{ reference: string; checkoutUrl: string; amountMinor: number }> {
  return h.service.checkout({
    ownerRef,
    planId: 'builder',
    interval: 'monthly',
    provider: 'paystack',
    email: input.email ?? `${ownerRef}@example.com`,
    name: 'Test Buyer',
    country: 'NG',
    ...(input.discountCode === undefined ? {} : { discountCode: input.discountCode }),
  });
}

function signed(body: string): string {
  return createHmac('sha512', 'whsec_fixture').update(body, 'utf8').digest('hex');
}

describe('pricing and quotes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('decides the amount from rows, not from the caller', async () => {
    const view = await h.service.quote({
      ownerRef: OWNER,
      planId: 'builder',
      interval: 'monthly',
    });
    expect(view.unitAmountMinor).toBe(1_500_000);
    expect(view.totalMinor).toBe(1_500_000);
    expect(view.currency).toBe('NGN');
    expect(view.taxName).toBeNull();
    expect(view.formatted).toBe('15,000.00 NGN');
  });

  it('applies a configured discount and tax in the documented order', async () => {
    await h.service.saveDiscount({
      actor: 'test',
      draft: { code: 'SAVE10', percentOff: 10 },
    });
    await h.service.saveTax({ actor: 'test', draft: { name: 'VAT', country: 'NG', rateBps: 750 } });
    await h.store.saveCustomer({
      ownerRef: OWNER,
      email: 'buyer@example.com',
      name: 'Test Buyer',
      country: 'NG',
      updatedAt: '2026-11-14T08:00:00.000Z',
    });
    const view = await h.service.quote({
      ownerRef: OWNER,
      planId: 'builder',
      interval: 'monthly',
      discountCode: 'save10',
    });
    expect(view.discountMinor).toBe(150_000);
    expect(view.subtotalMinor).toBe(1_350_000);
    expect(view.taxMinor).toBe(101_250);
    expect(view.totalMinor).toBe(1_451_250);
    expect(view.discountCode).toBe('SAVE10');
  });

  it('refuses a plan with no price and an unsupported currency', async () => {
    await expect(
      h.service.quote({ ownerRef: OWNER, planId: 'elite', interval: 'monthly' }),
    ).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
    await expect(
      h.service.quote({ ownerRef: OWNER, planId: 'builder', interval: 'monthly', currency: 'USD' }),
    ).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
    await expect(
      h.service.quote({ ownerRef: OWNER, planId: 'no-such-plan', interval: 'monthly' }),
    ).rejects.toMatchObject({ code: 'PLAN_UNAVAILABLE' });
  });

  it('refuses an unknown discount code instead of charging the full price silently', async () => {
    await expect(
      h.service.quote({
        ownerRef: OWNER,
        planId: 'builder',
        interval: 'monthly',
        discountCode: 'NOPE',
      }),
    ).rejects.toMatchObject({ code: 'DISCOUNT_REFUSED' });
  });
});

describe('checkout', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('initializes a hosted checkout with the server amount and a server reference', async () => {
    const session = await buy(h);
    expect(session.checkoutUrl).toContain('https://checkout.paystack.test/');
    expect(session.amountMinor).toBe(1_500_000);
    const initialise = h.fixture.calls.find((call) => call.url.includes('/transaction/initialize'));
    expect((initialise?.body as { amount: number }).amount).toBe(1_500_000);
    expect((initialise?.body as { reference: string }).reference).toBe(session.reference);
  });

  it('needs an email before it will take money', async () => {
    await expect(
      h.service.checkout({
        ownerRef: OWNER,
        planId: 'builder',
        interval: 'monthly',
        provider: 'paystack',
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_REQUIRED' });
  });

  it('refuses a provider that is not enabled', async () => {
    await expect(
      h.service.checkout({
        ownerRef: OWNER,
        planId: 'builder',
        interval: 'monthly',
        provider: 'flutterwave',
        email: 'buyer@example.com',
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
  });

  it('records the checkout as an intent before the customer leaves', async () => {
    const session = await buy(h);
    const intent = await h.store.findIntentByReference(session.reference);
    expect(intent?.status).toBe('open');
    expect(intent?.totalMinor).toBe(1_500_000);
  });
});

describe('verification', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it('grants the plan, writes an invoice and notifies once', async () => {
    const session = await buy(h);
    const result = await h.service.confirm({ ownerRef: OWNER, reference: session.reference });
    expect(result.status).toBe('paid');
    expect(result.transaction?.status).toBe('succeeded');

    const overview = await h.subscriptions.overview(OWNER);
    expect(overview.subscription?.planId).toBe('builder');
    expect(overview.subscription?.status).toBe('active');

    const invoice = await h.store.listInvoices(OWNER);
    expect(invoice).toHaveLength(1);
    expect(invoice[0]?.status).toBe('paid');
    expect(invoice[0]?.totalMinor).toBe(1_500_000);
    expect(invoice[0]?.number).toMatch(/^INV-2026-\d{6}$/);

    const notifications = await h.store.listNotifications(OWNER);
    expect(notifications.map((row) => row.kind)).toContain('payment-succeeded');
    expect(notifications.filter((row) => row.kind === 'payment-succeeded')).toHaveLength(1);
  });

  it('treats a second confirmation as already paid and buys nothing extra', async () => {
    const session = await buy(h);
    await h.service.confirm({ ownerRef: OWNER, reference: session.reference });
    const again = await h.service.confirm({ ownerRef: OWNER, reference: session.reference });
    expect(again.status).toBe('already-paid');
    const invoices = await h.store.listInvoices(OWNER);
    expect(invoices).toHaveLength(1);
    expect(await h.store.listTransactions(OWNER)).toHaveLength(1);
  });

  it('refuses a payment whose amount does not match the order', async () => {
    const session = await buy(h);
    // The provider reports a hundredth of what this server asked for.
    h.fixture.setVerify(session.reference, { amountMinor: 100 });
    const result = await h.service.confirm({ ownerRef: OWNER, reference: session.reference });
    expect(result.status).toBe('mismatch');
    expect((await h.subscriptions.overview(OWNER)).subscription).toBeNull();
    expect(await h.store.listInvoices(OWNER)).toHaveLength(0);
    const [transaction] = await h.store.listTransactions(OWNER);
    expect(transaction?.status).toBe('failed');
    expect(transaction?.failureReason).toMatch(/Amount mismatch/);
  });

  it('rejects a reference that belongs to another account', async () => {
    const session = await buy(h);
    await expect(
      h.service.confirm({ ownerRef: OTHER, reference: session.reference }),
    ).rejects.toMatchObject({ code: 'CHECKOUT_NOT_FOUND' });
    expect(await h.store.listTransactions(OTHER)).toHaveLength(0);
  });

  it('keeps an issued invoice unchanged when the price is edited later', async () => {
    const session = await buy(h);
    await h.service.confirm({ ownerRef: OWNER, reference: session.reference });
    const [before] = await h.store.listInvoices(OWNER);
    await h.service.savePrice({
      actor: 'test',
      draft: {
        planId: 'builder',
        interval: 'monthly',
        currency: 'NGN',
        amountMinor: 9_999_999,
      },
    });
    const [after] = await h.store.listInvoices(OWNER);
    expect(after?.totalMinor).toBe(before?.totalMinor);
    expect(after?.unitAmountMinor).toBe(1_500_000);
  });

  it('serves an invoice as a real PDF and a receipt too', async () => {
    const session = await buy(h);
    const result = await h.service.confirm({ ownerRef: OWNER, reference: session.reference });
    const invoiceId = result.invoice?.id ?? '';
    const pdf = await h.service.invoicePdf(OWNER, invoiceId, 'invoice');
    expect(pdf.bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.filename).toMatch(/^INV-2026-\d{6}\.pdf$/);
    const receipt = await h.service.invoicePdf(OWNER, invoiceId, 'receipt');
    expect(receipt.bytes.toString('latin1')).toContain('RECEIPT');
  });

  it('refuses another account reading an invoice', async () => {
    const session = await buy(h);
    const result = await h.service.confirm({ ownerRef: OWNER, reference: session.reference });
    await expect(h.service.invoice(OTHER, result.invoice?.id ?? '')).rejects.toMatchObject({
      code: 'INVOICE_NOT_FOUND',
    });
  });
});

describe('webhooks', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  function payload(reference: string, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      event: 'charge.success',
      data: {
        id: 501,
        reference,
        status: 'success',
        amount: 1_500_000,
        currency: 'NGN',
        paid_at: '2026-11-14T08:04:00.000Z',
        ...overrides,
      },
    });
  }

  it('rejects an unsigned delivery and records it as rejected', async () => {
    const session = await buy(h);
    const body = payload(session.reference);
    const result = await h.service.handleWebhook({
      provider: 'paystack',
      rawBody: body,
      headers: { 'x-paystack-signature': 'deadbeef' },
    });
    expect(result.status).toBe(401);
    const events = await h.store.listEvents();
    expect(events[0]?.status).toBe('rejected');
    expect(events[0]?.signatureValid).toBe(false);
    expect((await h.subscriptions.overview(OWNER)).subscription).toBeNull();
  });

  it('processes a signed delivery, and a redelivery changes nothing', async () => {
    const session = await buy(h);
    const body = payload(session.reference);
    const first = await h.service.handleWebhook({
      provider: 'paystack',
      rawBody: body,
      headers: { 'x-paystack-signature': signed(body) },
    });
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe('paid');

    const second = await h.service.handleWebhook({
      provider: 'paystack',
      rawBody: body,
      headers: { 'x-paystack-signature': signed(body) },
    });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const invoices = await h.store.listInvoices(OWNER);
    expect(invoices).toHaveLength(1);
    expect(await h.store.listTransactions(OWNER)).toHaveLength(1);
  });

  it('refuses an old event as a replay', async () => {
    const session = await buy(h);
    const body = payload(session.reference, { paid_at: '2026-11-14T05:00:00.000Z' });
    const result = await h.service.handleWebhook({
      provider: 'paystack',
      rawBody: body,
      headers: { 'x-paystack-signature': signed(body) },
    });
    expect(result.status).toBe(401);
    expect(String(result.body.reason)).toMatch(/replay/);
  });

  it('ignores a signed event that names no checkout on this deployment', async () => {
    const body = payload('vtv_unknown_reference');
    const result = await h.service.handleWebhook({
      provider: 'paystack',
      rawBody: body,
      headers: { 'x-paystack-signature': signed(body) },
    });
    expect(result.status).toBe(200);
    expect(result.body.ignored).toBe(true);
  });

  it('takes the owner from the intent, not from the request', async () => {
    const session = await buy(h);
    const body = payload(session.reference);
    await h.service.handleWebhook({
      provider: 'paystack',
      rawBody: body,
      headers: {
        'x-paystack-signature': signed(body),
        // A payload cannot reassign the purchase.
        'x-veltravia-owner-ref': OTHER,
      },
    });
    expect((await h.subscriptions.overview(OWNER)).subscription?.planId).toBe('builder');
    expect((await h.subscriptions.overview(OTHER)).subscription).toBeNull();
  });
});

describe('refunds', () => {
  let h: Harness;
  let transactionId: string;
  beforeEach(async () => {
    h = await harness();
    const session = await buy(h);
    const result = await h.service.confirm({ ownerRef: OWNER, reference: session.reference });
    transactionId = result.transaction?.id ?? '';
  });

  it('refuses without an explicit approval', async () => {
    await expect(
      h.service.refund({
        transactionId,
        reason: 'Customer asked',
        actor: 'operator',
        approve: false,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_NOT_APPROVED' });
    expect(await h.store.listRefunds(OWNER)).toHaveLength(0);
  });

  it('refunds through the provider and marks the transaction refunded', async () => {
    const refund = await h.service.refund({
      transactionId,
      reason: 'Customer asked within the window',
      actor: 'operator',
      approve: true,
    });
    expect(refund.status).toBe('succeeded');
    expect(refund.providerReference).toBe('909');
    const transaction = await h.store.readTransaction(transactionId);
    expect(transaction?.status).toBe('refunded');
    expect(h.fixture.calls.some((call) => call.url.includes('/refund'))).toBe(true);
  });

  it('cannot refund the same payment twice', async () => {
    await h.service.refund({
      transactionId,
      reason: 'First refund',
      actor: 'operator',
      approve: true,
    });
    await expect(
      h.service.refund({
        transactionId,
        reason: 'Second attempt',
        actor: 'operator',
        approve: true,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_NOT_POSSIBLE' });
  });

  it('cannot refund more than the payment took', async () => {
    await expect(
      h.service.refund({
        transactionId,
        amountMinor: 5_000_000,
        reason: 'Too much',
        actor: 'operator',
        approve: true,
      }),
    ).rejects.toMatchObject({ code: 'REFUND_TOO_LARGE' });
  });

  it('leaves the paid period alone under the default policy', async () => {
    await h.service.refund({
      transactionId,
      reason: 'Goodwill',
      actor: 'operator',
      approve: true,
    });
    expect((await h.subscriptions.overview(OWNER)).subscription?.status).toBe('active');
  });
});

describe('renewal', () => {
  it('will not renew before the paid period has ended', async () => {
    const h = await harness();
    const session = await buy(h);
    await h.service.confirm({ ownerRef: OWNER, reference: session.reference });
    const result = await h.service.chargeRenewal({ ownerRef: OWNER, actor: 'operator' });
    expect(result.charged).toBe(false);
    expect(result.reason).toMatch(/nothing to renew yet/);
  });

  it('offers a manual renewal when no authorization can be charged', async () => {
    const h = await harness();
    const session = await buy(h);
    await h.service.confirm({ ownerRef: OWNER, reference: session.reference });
    await h.store.clearPaymentMethod(OWNER);
    h.setNow('2026-12-20T08:00:00.000Z');
    const result = await h.service.chargeRenewal({ ownerRef: OWNER, actor: 'operator' });
    expect(result.charged).toBe(false);
    expect(result.checkoutUrl).toContain('https://app.veltravia.test/#/billing');
    expect(result.reason).toMatch(/renewal link/i);
  });

  it('charges a stored authorization and advances the period', async () => {
    const h = await harness({ withMethod: true });
    const session = await buy(h);
    await h.service.confirm({ ownerRef: OWNER, reference: session.reference });
    const before = await h.subscriptions.overview(OWNER);
    h.setNow('2026-12-20T08:00:00.000Z');
    const result = await h.service.chargeRenewal({ ownerRef: OWNER, actor: 'operator' });
    expect(result.charged).toBe(true);
    const after = await h.subscriptions.overview(OWNER);
    expect(Date.parse(after.subscription?.currentPeriodEnd ?? '')).toBeGreaterThan(
      Date.parse(before.subscription?.currentPeriodEnd ?? ''),
    );
    expect(h.fixture.calls.some((call) => call.url.includes('charge_authorization'))).toBe(true);
  });
});

describe('HTTP routes', () => {
  let app: FastifyInstance;
  let h: Harness;

  const env: NodeJS.ProcessEnv = {
    VELTRAVIA_BILLING_ADMIN_TOKEN: ADMIN,
    PAYSTACK_SECRET_KEY: 'sk_test_fixture',
    PAYSTACK_WEBHOOK_SECRET: 'whsec_fixture',
    VELTRAVIA_DEFAULT_OWNER_REF: OWNER,
  };

  beforeEach(async () => {
    h = await harness();
    app = buildApp({ env, payments: h.service });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('publishes prices and enabled providers without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/payments/prices' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { prices: unknown[]; providers: { provider: string }[] };
    expect(body.prices).toHaveLength(2);
    expect(body.providers[0]?.provider).toBe('paystack');
  });

  it('runs checkout and confirmation as the caller', async () => {
    const checkout = await app.inject({
      method: 'POST',
      url: '/api/payments/checkout',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: {
        planId: 'builder',
        interval: 'monthly',
        provider: 'paystack',
        email: 'buyer@example.com',
      },
    });
    expect(checkout.statusCode).toBe(201);
    const body = checkout.json() as { reference: string };

    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/payments/confirm',
      headers: { 'x-veltravia-owner-ref': OWNER },
      payload: { reference: body.reference },
    });
    expect(confirmed.statusCode).toBe(200);
    expect((confirmed.json() as { status: string }).status).toBe('paid');

    const overview = await app.inject({
      method: 'GET',
      url: '/api/payments',
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    const view = overview.json() as { invoices: unknown[]; transactions: unknown[] };
    expect(view.invoices).toHaveLength(1);
    expect(view.transactions).toHaveLength(1);
  });

  it('accepts a signed webhook with the raw bytes and refuses a tampered one', async () => {
    const session = await buy(h);
    const body = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 777,
        reference: session.reference,
        status: 'success',
        amount: 1_500_000,
        currency: 'NGN',
        paid_at: '2026-11-14T08:04:00.000Z',
      },
    });

    const tampered = await app.inject({
      method: 'POST',
      url: '/api/payments/webhook/paystack',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': 'nope' },
      payload: body,
    });
    expect(tampered.statusCode).toBe(401);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/payments/webhook/paystack',
      headers: { 'content-type': 'application/json', 'x-paystack-signature': signed(body) },
      payload: body,
    });
    expect(accepted.statusCode).toBe(200);
    expect((accepted.json() as { outcome?: string }).outcome).toBe('paid');
  });

  it('closes the operator surface without a token and opens it with one', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/payments/admin/overview',
    });
    expect(anonymous.statusCode).toBe(403);

    const wrong = await app.inject({
      method: 'GET',
      url: '/api/payments/admin/overview',
      headers: { 'x-veltravia-admin': 'not-the-token' },
    });
    expect(wrong.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/payments/admin/overview',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(allowed.statusCode).toBe(200);
    const body = allowed.json() as { providers: { provider: PaymentProviderId }[] };
    expect(body.providers.length).toBe(3);
  });

  it('refuses a price write without the operator token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/payments/admin/prices',
      payload: { planId: 'builder', interval: 'monthly', currency: 'NGN', amountMinor: 1 },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a refund without approval, and accepts one with it', async () => {
    const session = await buy(h);
    const confirmed = await h.service.confirm({
      ownerRef: OWNER,
      reference: session.reference,
    });
    const transactionId = confirmed.transaction?.id ?? '';

    const refused = await app.inject({
      method: 'POST',
      url: '/api/payments/admin/refunds',
      headers: { 'x-veltravia-admin': ADMIN },
      payload: { transactionId, reason: 'Asked' },
    });
    expect(refused.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/payments/admin/refunds',
      headers: { 'x-veltravia-admin': ADMIN },
      payload: { transactionId, reason: 'Asked', approve: true },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('downloads an invoice as a PDF only for its owner', async () => {
    const session = await buy(h);
    const result = await h.service.confirm({ ownerRef: OWNER, reference: session.reference });
    const invoiceId = result.invoice?.id ?? '';

    const mine = await app.inject({
      method: 'GET',
      url: `/api/payments/invoices/${invoiceId}/pdf`,
      headers: { 'x-veltravia-owner-ref': OWNER },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['content-type']).toContain('application/pdf');

    const theirs = await app.inject({
      method: 'GET',
      url: `/api/payments/invoices/${invoiceId}/pdf`,
      headers: { 'x-veltravia-owner-ref': OTHER },
    });
    expect(theirs.statusCode).toBe(404);
  });
});
