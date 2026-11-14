import { describe, expect, it } from 'vitest';

import {
  CapabilityUnsupportedError,
  DEFAULT_GRACE_POLICY,
  InMemoryPaymentStore,
  PaymentError,
  ProviderError,
  applyRateBps,
  buildInvoiceDraft,
  buildQuote,
  capabilitiesFor,
  createAdapter,
  decideWebhook,
  discountRefusal,
  effectiveTax,
  formatAmount,
  formatInvoiceNumber,
  fromMajorUnits,
  invoiceDocument,
  normalizeDiscountDraft,
  normalizePriceDraft,
  parseInvoiceNumber,
  priceView,
  receiptDocument,
  refundEffect,
  renderPdf,
  resolvePrice,
  textWidth,
  toMajorUnitsString,
  webhookDedupeKey,
  isPdf,
  type DiscountRecord,
  type InvoiceRecord,
  type PaymentTransport,
  type PriceRecord,
  type TaxRecord,
} from './index.js';

const NOW = '2026-11-14T08:00:00.000Z';

function price(
  planId: string,
  interval: 'monthly' | 'yearly',
  amountMinor: number,
  currency = 'NGN',
): PriceRecord {
  return {
    id: `pr_${planId}_${interval}_${currency}`,
    planId,
    interval,
    currency,
    amountMinor,
    active: true,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    updatedBy: 'test',
  };
}

function discountPercent(code: string, percentOff: number): DiscountRecord {
  return {
    code,
    description: '',
    percentOff,
    amountOffMinor: null,
    currency: null,
    active: true,
    startsAt: null,
    expiresAt: null,
    maxRedemptions: null,
    redemptions: 0,
    createdAt: NOW,
    updatedAt: NOW,
    updatedBy: 'test',
  };
}

/** A transport that answers from a queue and records what it was asked. */
function fakeTransport(responses: readonly unknown[]): {
  transport: PaymentTransport;
  calls: { method: string; url: string; body?: unknown }[];
} {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let index = 0;
  const transport: PaymentTransport = async (request) => {
    calls.push({
      method: request.method,
      url: request.url,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    const next = responses[index];
    index += 1;
    if (next === undefined) throw new Error('No more fixture responses.');
    if (next instanceof Error) throw next;
    const body = next as { status?: number; body?: unknown };
    const status = body.status ?? 200;
    const payload = body.body ?? body;
    return { status, body: payload, raw: JSON.stringify(payload) };
  };
  return { transport, calls };
}

describe('money', () => {
  it('converts between minor and major units without a float', () => {
    expect(toMajorUnitsString(250_050, 'NGN')).toBe('2500.50');
    expect(toMajorUnitsString(5, 'NGN')).toBe('0.05');
    expect(toMajorUnitsString(2500, 'JPY')).toBe('2500');
    expect(fromMajorUnits('2500.50', 'NGN')).toBe(250_050);
    expect(fromMajorUnits(2500.5, 'NGN')).toBe(250_050);
    expect(fromMajorUnits('2500.5', 'NGN')).toBe(250_050);
  });

  it('refuses more precision than the currency has', () => {
    expect(() => fromMajorUnits('10.005', 'NGN')).toThrow(/decimal/);
    expect(() => fromMajorUnits('10.5', 'JPY')).toThrow(/fractional/);
  });

  it('formats an amount for a person', () => {
    expect(formatAmount(1_250_000, 'NGN')).toBe('12,500.00 NGN');
    expect(formatAmount(0, 'NGN')).toBe('0.00 NGN');
    expect(formatAmount(1500, 'JPY')).toBe('1,500 JPY');
  });

  it('applies a rate in basis points with integer arithmetic', () => {
    expect(applyRateBps(10_000, 750)).toBe(750);
    expect(applyRateBps(1, 500)).toBe(0);
    expect(applyRateBps(999, 1000)).toBe(100);
    expect(() => applyRateBps(100, 10_001)).toThrow();
  });
});

describe('pricing', () => {
  const prices = [price('builder', 'monthly', 1_500_000), price('builder', 'yearly', 15_000_000)];

  it('resolves exactly one price and refuses ambiguity', () => {
    expect(resolvePrice(prices, 'builder', 'monthly', 'ngn').amountMinor).toBe(1_500_000);
    const duplicated = [...prices, price('builder', 'monthly', 900_000)];
    expect(() => resolvePrice(duplicated, 'builder', 'monthly', 'NGN')).toThrow(
      expect.objectContaining({ code: 'PRICE_AMBIGUOUS' }),
    );
    expect(() => resolvePrice(prices, 'builder', 'monthly', 'USD')).toThrow(
      expect.objectContaining({ code: 'PRICE_UNAVAILABLE' }),
    );
  });

  it('computes the yearly saving for the comparison screen', () => {
    const [view] = priceView(prices, 'builder');
    expect(view?.monthly).toBe(1_500_000);
    expect(view?.yearly).toBe(15_000_000);
    // 12 monthly payments would be 18,000,000; a 15,000,000 year saves ~17%.
    expect(view?.yearlySavingPercent).toBe(17);
  });

  it('builds a quote from rows, in the documented order', () => {
    const quote = buildQuote({
      planId: 'builder',
      interval: 'monthly',
      currency: 'NGN',
      prices,
      discount: discountPercent('SAVE10', 10),
      discountCode: 'save10',
      tax: { name: 'VAT', rateBps: 750 },
      now: NOW,
    });
    expect(quote.unitAmountMinor).toBe(1_500_000);
    expect(quote.discountMinor).toBe(150_000);
    expect(quote.subtotalMinor).toBe(1_350_000);
    expect(quote.taxMinor).toBe(101_250);
    expect(quote.totalMinor).toBe(1_451_250);
    expect(quote.discountCode).toBe('SAVE10');
  });

  it('refuses a discount that is worth more than the plan', () => {
    const fixed: DiscountRecord = {
      ...discountPercent('BIG', 0),
      percentOff: 0,
      amountOffMinor: 2_000_000,
      currency: 'NGN',
    };
    expect(discountRefusal(fixed, { currency: 'NGN', now: NOW, amountMinor: 1_500_000 })).toMatch(
      /more than this plan costs/,
    );
    expect(() =>
      buildQuote({
        planId: 'builder',
        interval: 'monthly',
        currency: 'NGN',
        prices,
        discount: fixed,
        discountCode: 'BIG',
        tax: null,
        now: NOW,
      }),
    ).toThrow(expect.objectContaining({ code: 'DISCOUNT_REFUSED' }));
  });

  it('refuses an expired, used-up or wrong-currency discount', () => {
    const expired = { ...discountPercent('OLD', 10), expiresAt: '2026-01-01T00:00:00.000Z' };
    expect(discountRefusal(expired, { currency: 'NGN', now: NOW, amountMinor: 10_000 })).toMatch(
      /expired/,
    );
    const usedUp = { ...discountPercent('GONE', 10), maxRedemptions: 2, redemptions: 2 };
    expect(discountRefusal(usedUp, { currency: 'NGN', now: NOW, amountMinor: 10_000 })).toMatch(
      /used up/,
    );
    const usdOnly = {
      ...discountPercent('USDONLY', 0),
      percentOff: 0,
      amountOffMinor: 100,
      currency: 'USD',
    };
    expect(discountRefusal(usdOnly, { currency: 'NGN', now: NOW, amountMinor: 10_000 })).toMatch(
      /only applies in USD/,
    );
    expect(discountRefusal(null, { currency: 'NGN', now: NOW, amountMinor: 10_000 })).toMatch(
      /not recognised/,
    );
  });

  it('validates price and discount configuration field by field', () => {
    expect(
      normalizePriceDraft({
        planId: 'builder',
        interval: 'monthly',
        currency: 'ngn',
        amountMinor: 100,
      }),
    ).toEqual({
      planId: 'builder',
      interval: 'monthly',
      currency: 'NGN',
      amountMinor: 100,
      active: true,
    });
    expect(() =>
      normalizePriceDraft({ planId: 'B', interval: 'monthly', currency: 'NGN', amountMinor: 1 }),
    ).toThrow(PaymentError);
    expect(() =>
      normalizePriceDraft({
        planId: 'builder',
        interval: 'weekly',
        currency: 'NGN',
        amountMinor: 1,
      }),
    ).toThrow(/monthly or yearly/);
    expect(() =>
      normalizePriceDraft({
        planId: 'builder',
        interval: 'monthly',
        currency: 'NGN',
        amountMinor: -1,
      }),
    ).toThrow(/whole number/);
    expect(() => normalizeDiscountDraft({ code: 'AB', percentOff: 10 })).toThrow(/3 to 32/);
    expect(() => normalizeDiscountDraft({ code: 'ABC' })).toThrow(/not both and not neither/);
    expect(() =>
      normalizeDiscountDraft({ code: 'ABC', percentOff: 10, amountOffMinor: 100 }),
    ).toThrow(/not both/);
  });

  it('picks the tax for the buyer country, then the default', () => {
    const taxes: TaxRecord[] = [
      {
        id: 't1',
        name: 'VAT',
        country: 'NG',
        rateBps: 750,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
        updatedBy: 'test',
      },
      {
        id: 't2',
        name: 'Default',
        country: null,
        rateBps: 0,
        active: true,
        createdAt: NOW,
        updatedAt: NOW,
        updatedBy: 'test',
      },
    ];
    expect(effectiveTax(taxes, 'ng')).toEqual({ name: 'VAT', rateBps: 750 });
    expect(effectiveTax(taxes, 'GH')).toEqual({ name: 'Default', rateBps: 0 });
    expect(effectiveTax([], 'NG')).toBeNull();
  });
});

describe('provider adapters', () => {
  const credentials = {
    provider: 'paystack' as const,
    mode: 'test' as const,
    secretKey: 'sk_test_123',
    webhookSecret: 'whsec_123',
    transport: fakeTransport([]).transport,
  };

  it('initializes a Paystack checkout in minor units and returns its link', async () => {
    const { transport, calls } = fakeTransport([
      {
        status: 200,
        body: {
          status: true,
          data: { authorization_url: 'https://checkout.paystack.com/abc', reference: 'vtv_1' },
        },
      },
    ]);
    const adapter = createAdapter({ ...credentials, transport });
    const session = await adapter.initialize({
      reference: 'vtv_1',
      amountMinor: 1_451_250,
      currency: 'NGN',
      email: 'buyer@example.com',
      customerName: 'A Buyer',
      description: 'Builder monthly',
      callbackUrl: 'https://app.example.com/billing/return',
      metadata: { intentId: 'pi_1' },
    });
    expect(session.checkoutUrl).toBe('https://checkout.paystack.com/abc');
    expect(calls[0]?.url).toContain('/transaction/initialize');
    expect((calls[0]?.body as { amount: number }).amount).toBe(1_451_250);
  });

  it('verifies a Paystack transaction and reads the reusable authorization', async () => {
    const { transport } = fakeTransport([
      {
        status: 200,
        body: {
          status: true,
          data: {
            status: 'success',
            reference: 'vtv_1',
            amount: 1_451_250,
            currency: 'NGN',
            channel: 'card',
            paid_at: '2026-11-14T08:01:00.000Z',
            authorization: {
              authorization_code: 'AUTH_abc',
              reusable: true,
              brand: 'visa',
              last4: '4081',
              exp_month: '12',
              exp_year: '2030',
            },
          },
        },
      },
    ]);
    const adapter = createAdapter({ ...credentials, transport });
    const verified = await adapter.verify('vtv_1');
    expect(verified.status).toBe('succeeded');
    expect(verified.amountMinor).toBe(1_451_250);
    expect(verified.authorization?.code).toBe('AUTH_abc');
    expect(verified.authorization?.reusable).toBe(true);
  });

  it('reads a Flutterwave amount in major units back to minor', async () => {
    const { transport } = fakeTransport([
      {
        status: 200,
        body: {
          status: 'success',
          data: {
            id: 998877,
            tx_ref: 'vtv_2',
            status: 'successful',
            amount: 14512.5,
            currency: 'NGN',
            payment_type: 'card',
            created_at: '2026-11-14T08:01:00.000Z',
          },
        },
      },
    ]);
    const adapter = createAdapter({
      provider: 'flutterwave',
      mode: 'test',
      secretKey: 'FLWSECK_TEST',
      webhookSecret: 'hash',
      transport,
    });
    const verified = await adapter.verify('vtv_2');
    expect(verified.amountMinor).toBe(1_451_250);
    expect(verified.status).toBe('succeeded');
  });

  it('declares its own gaps instead of pretending', async () => {
    const { transport } = fakeTransport([]);
    const monnify = createAdapter({
      provider: 'monnify',
      mode: 'test',
      secretKey: 'api:secret',
      webhookSecret: 'whsec',
      transport,
    });
    expect(capabilitiesFor('monnify').recurring).toBe(false);
    await expect(
      monnify.chargeAuthorization({
        reference: 'vtv_3',
        amountMinor: 100,
        currency: 'NGN',
        email: 'a@b.c',
        authorizationCode: 'AUTH',
        description: '',
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
  });

  it('surfaces a provider refusal with its own message and retryability', async () => {
    const { transport } = fakeTransport([
      { status: 400, body: { status: false, message: 'Invalid amount' } },
    ]);
    const adapter = createAdapter({ ...credentials, transport });
    await expect(
      adapter.initialize({
        reference: 'vtv_4',
        amountMinor: 100,
        currency: 'NGN',
        email: 'a@b.c',
        customerName: 'A',
        description: '',
        callbackUrl: 'https://x.test',
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_REFUSED', retryable: false });
  });

  it('treats a network failure as retryable', async () => {
    const transport: PaymentTransport = async () => {
      throw new Error('ECONNRESET');
    };
    const adapter = createAdapter({ ...credentials, transport });
    await expect(adapter.verify('vtv_5')).rejects.toBeInstanceOf(ProviderError);
    await expect(adapter.verify('vtv_5')).rejects.toMatchObject({ retryable: true });
  });

  it('verifies a Paystack webhook signature over the exact body', async () => {
    const { createHmac } = await import('node:crypto');
    const adapter = createAdapter({ ...credentials, transport: fakeTransport([]).transport });
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'vtv_6' } });
    const signature = createHmac('sha512', 'whsec_123').update(body, 'utf8').digest('hex');
    expect(
      adapter.verifyWebhook({ rawBody: body, headers: { 'x-paystack-signature': signature } }),
    ).toEqual({ valid: true, reason: null });
    expect(
      adapter.verifyWebhook({ rawBody: body, headers: { 'x-paystack-signature': 'deadbeef' } }),
    ).toMatchObject({ valid: false });
    // A body edited after signing must not verify.
    expect(
      adapter.verifyWebhook({
        rawBody: body.replace('vtv_6', 'vtv_9'),
        headers: { 'x-paystack-signature': signature },
      }),
    ).toMatchObject({ valid: false });
  });

  it('verifies a Flutterwave pre-shared hash and refuses a missing header', async () => {
    const adapter = createAdapter({
      provider: 'flutterwave',
      mode: 'test',
      secretKey: 'k',
      webhookSecret: 'my-hash',
      transport: fakeTransport([]).transport,
    });
    expect(
      adapter.verifyWebhook({ rawBody: '{}', headers: { 'verif-hash': 'my-hash' } }).valid,
    ).toBe(true);
    expect(adapter.verifyWebhook({ rawBody: '{}', headers: {} }).valid).toBe(false);
  });

  it('parses each provider payload into one normalized event', () => {
    const paystack = createAdapter({ ...credentials, transport: fakeTransport([]).transport });
    const event = paystack.parseWebhook({
      rawBody: JSON.stringify({
        event: 'charge.success',
        data: { id: 42, reference: 'vtv_7', status: 'success', amount: 5000, currency: 'NGN' },
      }),
    });
    expect(event.reference).toBe('vtv_7');
    expect(event.status).toBe('succeeded');
    expect(event.eventId).toContain('42');

    const monnify = createAdapter({
      provider: 'monnify',
      mode: 'test',
      secretKey: 'a:b',
      webhookSecret: 'w',
      transport: fakeTransport([]).transport,
    });
    const monnifyEvent = monnify.parseWebhook({
      rawBody: JSON.stringify({
        eventType: 'SUCCESSFUL_TRANSACTION',
        eventData: {
          paymentReference: 'vtv_8',
          paymentStatus: 'PAID',
          currency: 'NGN',
          transactionReference: 'MNFY-1',
        },
      }),
    });
    expect(monnifyEvent.reference).toBe('vtv_8');
    expect(monnifyEvent.status).toBe('succeeded');
  });
});

describe('webhooks', () => {
  const baseEvent = {
    eventId: 'paystack:charge.success:42',
    eventType: 'charge.success',
    reference: 'vtv_1',
    amountMinor: 5000,
    currency: 'NGN',
    status: 'succeeded' as const,
    occurredAt: '2026-11-14T07:59:00.000Z',
    raw: {},
  };

  it('rejects a delivery whose signature did not verify', () => {
    const decision = decideWebhook({
      provider: 'paystack',
      event: baseEvent,
      signatureValid: false,
      signatureReason: 'The signature does not match the body.',
      now: NOW,
    });
    expect(decision.action).toBe('reject');
    expect(decision.reason).toMatch(/signature/);
  });

  it('rejects an event older than the replay window', () => {
    const decision = decideWebhook({
      provider: 'paystack',
      event: { ...baseEvent, occurredAt: '2026-11-14T06:00:00.000Z' },
      signatureValid: true,
      now: NOW,
    });
    expect(decision.action).toBe('reject');
    expect(decision.reason).toMatch(/replay/);
  });

  it('accepts a recent, signed event with a reference and focuses on verifying it', () => {
    const decision = decideWebhook({
      provider: 'paystack',
      event: baseEvent,
      signatureValid: true,
      now: NOW,
    });
    expect(decision.action).toBe('process');
    expect(decision.dedupeKey).toBe('paystack:charge.success:42');
  });

  it('ignores an event that names no purchase', () => {
    const decision = decideWebhook({
      provider: 'paystack',
      event: { ...baseEvent, reference: null },
      signatureValid: true,
      now: NOW,
    });
    expect(decision.action).toBe('ignore');
  });

  it('falls back to a body hash when the provider sends no event id', () => {
    const key = webhookDedupeKey('monnify', { ...baseEvent, eventId: '' });
    expect(key).toContain('hash:');
    expect(webhookDedupeKey('monnify', { ...baseEvent, eventId: '' })).toBe(key);
  });
});

describe('invoices and receipts', () => {
  const invoice: InvoiceRecord = {
    id: 'inv_1',
    number: formatInvoiceNumber(2026, 1),
    ownerRef: 'owner-1',
    workspaceId: 'ws-1',
    planId: 'builder',
    planName: 'Builder',
    interval: 'monthly',
    currency: 'NGN',
    unitAmountMinor: 1_500_000,
    discountMinor: 150_000,
    subtotalMinor: 1_350_000,
    taxName: 'VAT',
    taxRateBps: 750,
    taxMinor: 101_250,
    totalMinor: 1_451_250,
    status: 'paid',
    customerName: 'A Buyer',
    customerEmail: 'buyer@example.com',
    customerAddress: null,
    issuedAt: NOW,
    dueAt: NOW,
    paidAt: NOW,
    transactionReference: 'vtv_1',
    provider: 'paystack',
    notes: [],
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('numbers invoices per year and can read them back', () => {
    expect(formatInvoiceNumber(2026, 1)).toBe('INV-2026-000001');
    expect(formatInvoiceNumber(2026, 123_456)).toBe('INV-2026-123456');
    expect(parseInvoiceNumber('inv-2026-000042')).toEqual({ year: 2026, sequence: 42 });
    expect(parseInvoiceNumber('nonsense')).toBeNull();
    expect(() => formatInvoiceNumber(2026, 0)).toThrow();
  });

  it('copies the charged amounts into the invoice body', () => {
    const draft = buildInvoiceDraft({
      quote: {
        planId: 'builder',
        interval: 'monthly',
        currency: 'NGN',
        unitAmountMinor: 1_500_000,
        discountCode: null,
        discountMinor: 0,
        subtotalMinor: 1_500_000,
        taxName: null,
        taxRateBps: 0,
        taxMinor: 0,
        totalMinor: 1_500_000,
      },
      planName: 'Builder',
      interval: 'monthly',
      customer: { name: 'A Buyer', email: 'buyer@example.com', address: null },
      issuedAt: NOW,
      dueInDays: 7,
    });
    expect(draft.totalMinor).toBe(1_500_000);
    expect(new Date(draft.dueAt as string).toISOString()).toBe('2026-11-21T08:00:00.000Z');
    expect(draft.notes.join(' ')).toMatch(/No tax was configured/);
  });

  it('renders a real PDF for an invoice and for a receipt', () => {
    const invoicePdf = renderPdf(invoiceDocument(invoice));
    expect(isPdf(invoicePdf)).toBe(true);
    const text = invoicePdf.toString('latin1');
    expect(text).toContain('INV-2026-000001');
    expect(text).toContain('14,512.50 NGN');
    expect(text).toContain('%%EOF');

    const receiptPdf = renderPdf(receiptDocument({ ...invoice, status: 'refunded' }));
    expect(isPdf(receiptPdf)).toBe(true);
    expect(receiptPdf.toString('latin1')).toContain('RECEIPT');
  });

  it('paginates a long document instead of writing off the page', () => {
    const long = invoiceDocument({
      ...invoice,
      notes: Array.from({ length: 90 }, (_, index) => `Note number ${index + 1} for the record.`),
    });
    const pdf = renderPdf(long);
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.toString('latin1')).toContain('/Count 2');
  });

  it('measures text so a right-aligned amount lands near the margin', () => {
    expect(textWidth('100.00 NGN', 10, false)).toBeGreaterThan(40);
    expect(textWidth('100.00 NGN', 10, true)).toBeGreaterThan(40);
  });
});

describe('policies', () => {
  it('states what a refund does to a subscription', () => {
    expect(refundEffect('none').leavesSubscriptionAlone).toBe(true);
    expect(refundEffect('cancel-at-period-end').cancelAtPeriodEnd).toBe(true);
    expect(refundEffect('cancel-immediately').cancelImmediately).toBe(true);
  });

  it('keeps a finite retry schedule and a bounded grace period', () => {
    expect(DEFAULT_GRACE_POLICY.retryScheduleMinutes.length).toBeLessThanOrEqual(5);
    expect(DEFAULT_GRACE_POLICY.fallsBackToIncludedAllowance).toBe(true);
  });
});

describe('the in-memory store holds the same guarantees', () => {
  it('refuses a second transaction with the same provider reference', async () => {
    const store = new InMemoryPaymentStore();
    const transaction = {
      id: 'tx_1',
      ownerRef: 'owner-1',
      intentId: 'pi_1',
      provider: 'paystack' as const,
      mode: 'test' as const,
      providerReference: 'vtv_1',
      amountMinor: 100,
      currency: 'NGN',
      status: 'succeeded' as const,
      kind: 'initial' as const,
      planId: 'builder',
      interval: 'monthly' as const,
      verifiedAt: NOW,
      failureReason: null,
      channel: 'card',
      createdAt: NOW,
      updatedAt: NOW,
    };
    await store.insertTransaction(transaction);
    await expect(store.insertTransaction({ ...transaction, id: 'tx_2' })).rejects.toMatchObject({
      code: 'REFERENCE_ALREADY_USED',
    });
  });

  it('records one event per dedupe key and one notification per key', async () => {
    const store = new InMemoryPaymentStore();
    const event = {
      id: 'ev_1',
      ownerRef: null,
      provider: 'paystack' as const,
      mode: 'test' as const,
      eventType: 'charge.success',
      dedupeKey: 'paystack:charge.success:42',
      reference: 'vtv_1',
      signatureValid: true,
      status: 'received' as const,
      note: null,
      attempts: 1,
      receivedAt: NOW,
      processedAt: null,
    };
    expect(await store.insertEvent(event)).toEqual({ created: true });
    expect(await store.insertEvent({ ...event, id: 'ev_2' })).toEqual({ created: false });

    const notification = {
      id: 'nt_1',
      ownerRef: 'owner-1',
      kind: 'payment-succeeded' as const,
      dedupeKey: 'payment-succeeded:vtv_1',
      title: 'Payment received',
      message: 'Your payment was received.',
      subjectId: 'vtv_1',
      createdAt: NOW,
      readAt: null,
    };
    expect(await store.insertNotification(notification)).toEqual({ created: true });
    expect(await store.insertNotification({ ...notification, id: 'nt_2' })).toEqual({
      created: false,
    });
  });

  it('increments the invoice sequence per year', async () => {
    const store = new InMemoryPaymentStore();
    expect(await store.nextInvoiceSequence(2026)).toBe(1);
    expect(await store.nextInvoiceSequence(2026)).toBe(2);
    expect(await store.nextInvoiceSequence(2027)).toBe(1);
  });
});
