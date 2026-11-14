/**
 * Payments (Step 61).
 *
 * The one place that turns money into a plan. It owns:
 *
 *  - **configuration** - which providers are enabled, in which mode, at what
 *    price, with what discount and tax rows;
 *  - **checkout** - a server-decided amount, a reference this server issued and a
 *    hosted page the customer is sent to;
 *  - **verification** - the only way a payment becomes `succeeded`. A redirect
 *    calls `confirm`, which asks the provider; a webhook calls `handleWebhook`,
 *    which proves the signature and then asks the provider too;
 *  - **granting** - connecting a verified payment to the Step 60 subscription,
 *    exactly once per period;
 *  - **evidence** - an invoice, a receipt, a notification and an audit row.
 *
 * What it deliberately does not do: it never charges a card it did not tokenize,
 * it never grants a paid entitlement from a payload, it never refunds on its own,
 * and it never edits a ledger row. Credits stay in Steps 52-59 and are a
 * *ceiling* the plan grants, not a deposit this service makes.
 */

import {
  DEFAULT_GRACE_POLICY,
  DEFAULT_REFUND_POLICY,
  InMemoryPaymentStore,
  INTENT_TTL_MS,
  PaymentError,
  buildInvoiceDraft,
  buildQuote,
  capabilitiesFor,
  createAdapter,
  decideWebhook,
  effectiveTax,
  formatAmount,
  formatInvoiceNumber,
  invoiceDocument,
  invoiceYear,
  isBillingInterval,
  isPaymentProvider,
  normalizeDiscountDraft,
  normalizePriceDraft,
  normalizeTaxDraft,
  receiptDocument,
  refundEffect,
  renderPdf,
  type BillingCustomer,
  type BillingNotificationRecord,
  type DiscountRecord,
  type InvoiceRecord,
  type NormalizedEvent,
  type PaymentEventRecord,
  type PaymentIntentRecord,
  type PaymentMethodRecord,
  type PaymentMode,
  type PaymentProviderId,
  type PaymentStore,
  type PaymentTransactionRecord,
  type PriceRecord,
  type PaymentTransport,
  type ProviderAdapter,
  type ProviderSettings,
  type PurchaseQuote,
  type RefundPolicy,
  type RefundRecord,
  type TaxRecord,
  type GracePolicy,
  type BillingInterval,
} from '@veltravia/payments-core';
import { runWithOwner } from '@veltravia/storage-postgres';

import type { SubscriptionService } from './subscription-service.js';

/** Where each provider's secrets live, unless an operator points elsewhere. */
export const DEFAULT_SECRET_REFS: Readonly<
  Record<PaymentProviderId, { readonly secretKeyEnv: string; readonly webhookSecretEnv: string }>
> = {
  paystack: { secretKeyEnv: 'PAYSTACK_SECRET_KEY', webhookSecretEnv: 'PAYSTACK_WEBHOOK_SECRET' },
  flutterwave: {
    secretKeyEnv: 'FLUTTERWAVE_SECRET_KEY',
    webhookSecretEnv: 'FLUTTERWAVE_WEBHOOK_HASH',
  },
  monnify: { secretKeyEnv: 'MONNIFY_SECRET_KEY', webhookSecretEnv: 'MONNIFY_WEBHOOK_SECRET' },
};

const PROVIDER_NAMES: Readonly<Record<PaymentProviderId, string>> = {
  paystack: 'Paystack',
  flutterwave: 'Flutterwave',
  monnify: 'Monnify',
};

const DEFAULT_MODE: PaymentMode = 'test';

export interface PaymentServiceOptions {
  readonly store?: PaymentStore;
  /** Step 60's service. The only thing that may change a plan. */
  readonly subscriptions: SubscriptionService;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly newId?: (prefix: string) => string;
  readonly readSecret?: (name: string) => string;
  readonly refundPolicy?: RefundPolicy;
  readonly gracePolicy?: GracePolicy;
  /** Where the customer is sent back to. Must be the web app's billing route. */
  readonly publicBaseUrl?: string;
  /**
   * The HTTP transport every adapter uses. Injected so a test can answer from a
   * fixture and so production keeps one seam; the default is `fetch`.
   */
  readonly transport?: PaymentTransport;
  /** Told about every notification that was actually new, so a deployment can email. */
  readonly onNotification?: (notification: BillingNotificationRecord) => void;
}

export interface ProviderView {
  readonly provider: PaymentProviderId;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly mode: PaymentMode;
  readonly configured: boolean;
  readonly publicKey: string | null;
  readonly currencies: readonly string[];
  readonly capabilities: ProviderSettings['capabilities'];
}

export interface QuoteView {
  readonly planId: string;
  readonly planName: string;
  readonly interval: BillingInterval;
  readonly currency: string;
  readonly unitAmountMinor: number;
  readonly discountMinor: number;
  readonly discountCode: string | null;
  readonly subtotalMinor: number;
  readonly taxName: string | null;
  readonly taxRateBps: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly formatted: string;
  readonly providers: readonly ProviderView[];
  readonly note: string;
}

export interface CheckoutView {
  readonly intentId: string;
  readonly reference: string;
  readonly checkoutUrl: string;
  readonly provider: PaymentProviderId;
  readonly mode: PaymentMode;
  readonly amountMinor: number;
  readonly currency: string;
  readonly expiresAt: string;
}

export interface SettleResult {
  readonly status: 'paid' | 'already-paid' | 'failed' | 'pending' | 'mismatch';
  readonly reference: string;
  readonly transaction: PaymentTransactionRecord | null;
  readonly invoice: InvoiceRecord | null;
  readonly planId: string | null;
  readonly reason: string | null;
}

export interface BillingOverview {
  readonly plan: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly entitled: boolean;
    readonly interval: BillingInterval | null;
    readonly currentPeriodEnd: string | null;
    readonly renews: boolean;
    readonly cancelAtPeriodEnd: boolean;
    readonly daysRemaining: number;
  };
  readonly subscription: {
    readonly status: string;
    readonly source: string;
    readonly reason: string | null;
    readonly monthlyMessageCredits: number;
    readonly monthlyIntegrationCredits: number;
  };
  readonly prices: readonly {
    readonly planId: string;
    readonly planName: string;
    readonly currency: string;
    readonly monthly: number | null;
    readonly yearly: number | null;
    readonly yearlySavingPercent: number | null;
  }[];
  readonly providers: readonly ProviderView[];
  readonly paymentMethod: {
    readonly brand: string | null;
    readonly last4: string | null;
    readonly expMonth: string | null;
    readonly expYear: string | null;
    readonly provider: PaymentProviderId;
    readonly reusable: boolean;
  } | null;
  readonly transactions: readonly PaymentTransactionRecord[];
  readonly invoices: readonly InvoiceRecord[];
  readonly refunds: readonly RefundRecord[];
  readonly notifications: readonly BillingNotificationRecord[];
  readonly policies: {
    readonly refund: { readonly policy: RefundPolicy; readonly note: string };
    readonly grace: GracePolicy;
    readonly taxConfigured: boolean;
    readonly topUps: false;
  };
  readonly customer: { readonly email: string; readonly name: string } | null;
  readonly durable: boolean;
  readonly note: string;
}

export interface PaymentService {
  readonly durable: boolean;
  readonly refundPolicy: RefundPolicy;
  ensure(): Promise<void>;
  providers(ownerRef?: string): Promise<readonly ProviderView[]>;
  prices(): Promise<readonly PriceRecord[]>;
  discounts(): Promise<readonly DiscountRecord[]>;
  taxes(): Promise<readonly TaxRecord[]>;
  quote(input: {
    ownerRef: string;
    planId: string;
    interval: string;
    currency?: string | null;
    discountCode?: string | null;
  }): Promise<QuoteView>;
  checkout(input: {
    ownerRef: string;
    planId: string;
    interval: string;
    provider: string;
    currency?: string | null;
    discountCode?: string | null;
    email?: string | null;
    name?: string | null;
    country?: string | null;
    workspaceId?: string | null;
  }): Promise<CheckoutView>;
  confirm(input: { ownerRef: string; reference: string }): Promise<SettleResult>;
  overview(ownerRef: string): Promise<BillingOverview>;
  invoice(ownerRef: string, invoiceId: string): Promise<InvoiceRecord>;
  invoicePdf(
    ownerRef: string,
    invoiceId: string,
    kind?: 'invoice' | 'receipt',
  ): Promise<{ readonly bytes: Buffer; readonly filename: string }>;
  markNotificationsRead(ownerRef: string, ids?: readonly string[]): Promise<number>;
  handleWebhook(input: {
    provider: string;
    mode?: string;
    rawBody: string;
    headers: Readonly<Record<string, string | string[] | undefined>>;
  }): Promise<{ readonly status: number; readonly body: Record<string, unknown> }>;
  renewalsDue(limit?: number): Promise<readonly { ownerRef: string; periodEnd: string }[]>;
  chargeRenewal(input: { ownerRef: string; actor: string }): Promise<{
    readonly charged: boolean;
    readonly checkoutUrl: string | null;
    readonly reason: string;
  }>;
  sendRenewalReminders(): Promise<{ readonly sent: number }>;
  configureProvider(input: {
    provider: string;
    mode?: string;
    enabled?: boolean;
    displayName?: string;
    publicKey?: string | null;
    secretKeyEnv?: string;
    webhookSecretEnv?: string;
    currencies?: readonly string[];
    actor: string;
  }): Promise<ProviderSettings>;
  savePrice(input: { draft: unknown; actor: string }): Promise<PriceRecord>;
  saveDiscount(input: { draft: unknown; actor: string }): Promise<DiscountRecord>;
  saveTax(input: { draft: unknown; actor: string }): Promise<TaxRecord>;
  refund(input: {
    transactionId: string;
    amountMinor?: number;
    reason: string;
    actor: string;
    approve: boolean;
    note?: string | null;
  }): Promise<RefundRecord>;
  reconcile(input: { actor: string; limit?: number }): Promise<{
    readonly checked: number;
    readonly verified: number;
    readonly failed: number;
    readonly expiredIntents: number;
  }>;
  events(limit?: number, status?: string): Promise<readonly PaymentEventRecord[]>;
  transactions(filter?: {
    status?: string;
    provider?: string;
    limit?: number;
  }): Promise<readonly PaymentTransactionRecord[]>;
  audit(ownerRef: string, limit?: number): Promise<readonly unknown[]>;
  platformAudit(limit?: number): Promise<readonly unknown[]>;
}

/** One row per plan and currency, for the plan comparison. */
function priceBookView(prices: readonly PriceRecord[]): readonly {
  planId: string;
  currency: string;
  monthly: number | null;
  yearly: number | null;
  yearlySavingPercent: number | null;
}[] {
  const keys = [
    ...new Set(
      prices.filter((price) => price.active).map((price) => `${price.planId}:${price.currency}`),
    ),
  ].sort();
  return keys.map((key) => {
    const [planId = '', currency = ''] = key.split(':');
    const monthly = prices.find(
      (row) =>
        row.active &&
        row.planId === planId &&
        row.currency === currency &&
        row.interval === 'monthly',
    );
    const yearly = prices.find(
      (row) =>
        row.active &&
        row.planId === planId &&
        row.currency === currency &&
        row.interval === 'yearly',
    );
    const monthlyAmount = monthly?.amountMinor ?? null;
    const yearlyAmount = yearly?.amountMinor ?? null;
    const full = monthlyAmount === null ? 0 : monthlyAmount * 12;
    return {
      planId,
      currency,
      monthly: monthlyAmount,
      yearly: yearlyAmount,
      yearlySavingPercent:
        full > 0 && yearlyAmount !== null
          ? Math.max(0, Math.round(((full - yearlyAmount) / full) * 100))
          : null,
    };
  });
}

function stableId(prefix: string, stamp: number, seq: number): string {
  return `${prefix}_${stamp.toString(36)}${seq.toString(36).padStart(3, '0')}`;
}

export function createPaymentService(options: PaymentServiceOptions): PaymentService {
  const now = options.now ?? (() => new Date());
  const store: PaymentStore = options.store ?? new InMemoryPaymentStore();
  const durable = options.store !== undefined;
  const env = options.env ?? process.env;
  const subscriptions = options.subscriptions;
  const readSecret =
    options.readSecret ?? ((name: string): string => (name === '' ? '' : (env[name] ?? '').trim()));
  const refundPolicy = options.refundPolicy ?? DEFAULT_REFUND_POLICY;
  const gracePolicy = options.gracePolicy ?? DEFAULT_GRACE_POLICY;
  const publicBaseUrl = (
    options.publicBaseUrl ??
    env.VELTRAVIA_PUBLIC_BASE_URL ??
    'http://localhost:5173'
  ).replace(/\/+$/, '');

  let seq = 0;
  const newId = options.newId ?? ((prefix: string) => stableId(prefix, now().getTime(), ++seq));

  const isoNow = (): string => now().toISOString();

  /* ------------------------------------------------------------- plumbing */

  const audit = async (
    scope: 'platform' | 'owner',
    ownerRef: string,
    action: Parameters<PaymentStore['appendAudit']>[0]['action'],
    actor: string,
    subject: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> => {
    await store
      .appendAudit({
        id: newId('ba'),
        scope,
        ownerRef,
        action,
        actor,
        subject,
        detail,
        at: isoNow(),
      })
      .catch(() => undefined);
  };

  /**
   * Writes a notification once per dedupe key and returns whether it was new.
   * A repeat is not an error: a retried webhook must not mail the customer twice.
   */
  const notify = async (input: {
    ownerRef: string;
    kind: BillingNotificationRecord['kind'];
    dedupeKey: string;
    title: string;
    message: string;
    subjectId: string | null;
  }): Promise<boolean> => {
    const created = await store.insertNotification({
      id: newId('bn'),
      ownerRef: input.ownerRef,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      title: input.title,
      message: input.message,
      subjectId: input.subjectId,
      createdAt: isoNow(),
      readAt: null,
    });
    if (created.created) {
      await audit('owner', input.ownerRef, 'notification.sent', 'payments', input.dedupeKey, {
        kind: input.kind,
      });
      options.onNotification?.({
        id: 'pending',
        ownerRef: input.ownerRef,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        title: input.title,
        message: input.message,
        subjectId: input.subjectId,
        createdAt: isoNow(),
        readAt: null,
      });
    }
    return created.created;
  };

  /* ---------------------------------------------------------- configuration */

  const ensure = async (): Promise<void> => {
    for (const provider of ['paystack', 'flutterwave', 'monnify'] as const) {
      const existing = await store.readProvider(provider, DEFAULT_MODE);
      if (existing !== null) continue;
      await store.saveProvider({
        provider,
        displayName: PROVIDER_NAMES[provider],
        enabled: false,
        mode: DEFAULT_MODE,
        publicKey: null,
        secretRefs: DEFAULT_SECRET_REFS[provider],
        currencies: [...capabilitiesFor(provider).currencies],
        capabilities: capabilitiesFor(provider),
        version: 1,
        updatedAt: isoNow(),
        updatedBy: 'system',
      });
    }
  };

  const providerSettings = async (
    provider: PaymentProviderId,
    mode?: PaymentMode,
  ): Promise<ProviderSettings> => {
    const settings = await store.readProvider(provider, mode ?? DEFAULT_MODE);
    if (settings === null) {
      throw new PaymentError(
        'PROVIDER_UNKNOWN',
        `There is no ${provider} configuration in this deployment.`,
        404,
        { provider },
      );
    }
    return settings;
  };

  const toView = (settings: ProviderSettings): ProviderView => ({
    provider: settings.provider,
    displayName: settings.displayName,
    enabled: settings.enabled,
    mode: settings.mode,
    configured: readSecret(settings.secretRefs.secretKeyEnv) !== '',
    publicKey: settings.publicKey,
    currencies: settings.currencies,
    capabilities: settings.capabilities,
  });

  const adapterFor = async (
    provider: PaymentProviderId,
    mode?: PaymentMode,
  ): Promise<{ adapter: ProviderAdapter; settings: ProviderSettings }> => {
    const settings = await providerSettings(provider, mode);
    if (!settings.enabled) {
      throw new PaymentError(
        'PROVIDER_DISABLED',
        `${settings.displayName} is not enabled for this deployment.`,
        409,
        { provider },
      );
    }
    const secretKey = readSecret(settings.secretRefs.secretKeyEnv);
    if (secretKey === '') {
      throw new PaymentError(
        'PROVIDER_NOT_CONFIGURED',
        `${settings.displayName} has no secret key configured, so no payment can be taken.`,
        409,
        { provider },
      );
    }
    const webhookSecret = readSecret(settings.secretRefs.webhookSecretEnv);
    const adapter = createAdapter({
      provider,
      mode: settings.mode,
      secretKey,
      webhookSecret,
      transport:
        options.transport ??
        (async (request) => {
          const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          });
          const raw = await response.text();
          let parsed: unknown = null;
          if (raw !== '') {
            try {
              parsed = JSON.parse(raw) as unknown;
            } catch {
              // A non-JSON body is still returned raw so the adapter can report it.
              parsed = null;
            }
          }
          return { status: response.status, body: parsed, raw };
        }),
    });
    return { adapter, settings };
  };

  const customer = async (ownerRef: string): Promise<BillingCustomer | null> =>
    store.readCustomer(ownerRef);

  /* ---------------------------------------------------------------- quotes */

  const priceRows = (): Promise<readonly PriceRecord[]> => store.listPrices();

  const chooseCurrency = async (
    planId: string,
    interval: BillingInterval,
    requested: string | null | undefined,
  ): Promise<string> => {
    const prices = await store.listPrices();
    const available = [
      ...new Set(
        prices
          .filter((price) => price.active && price.planId === planId && price.interval === interval)
          .map((price) => price.currency),
      ),
    ].sort();
    if (requested !== null && requested !== undefined && requested.trim() !== '') {
      return requested.trim().toUpperCase();
    }
    const preferred = (env.VELTRAVIA_BILLING_CURRENCY ?? '').trim().toUpperCase();
    if (preferred !== '' && available.includes(preferred)) return preferred;
    if (available.length === 1) return available[0] as string;
    if (available.length > 1) {
      throw new PaymentError(
        'CURRENCY_REQUIRED',
        'This plan is priced in more than one currency. Choose one.',
        400,
        { currencies: available },
      );
    }
    throw new PaymentError(
      'PRICE_UNAVAILABLE',
      'This plan has no price configured yet, so it cannot be bought.',
      409,
      { planId, interval },
    );
  };

  /** The plan row, or a refusal that says which kind of unavailability it is. */
  const planOrThrow = async (planId: string) => {
    const plans = await subscriptions.catalogue();
    const plan = plans.find((candidate) => candidate.id === planId);
    if (plan === undefined || !plan.active) {
      throw new PaymentError('PLAN_UNAVAILABLE', 'That plan is not available.', 404, { planId });
    }
    return plan;
  };

  const quoteFor = async (input: {
    ownerRef: string;
    planId: string;
    interval: BillingInterval;
    currency: string;
    discountCode: string | null;
  }): Promise<{ quote: PurchaseQuote; planName: string }> => {
    const plans = await subscriptions.catalogue();
    const plan = plans.find((candidate) => candidate.id === input.planId);
    if (plan === undefined || !plan.active) {
      throw new PaymentError('PLAN_UNAVAILABLE', 'That plan is not available.', 404, {
        planId: input.planId,
      });
    }
    const buyer = await customer(input.ownerRef);
    const tax = effectiveTax(await store.listTaxes(), buyer?.country ?? null);
    // Every refusal - unknown, expired, used up, wrong currency, worth more than
    // the plan - is decided by `buildQuote` against the real price.
    const discount =
      input.discountCode === null ? null : await store.readDiscount(input.discountCode);
    const quote = buildQuote({
      planId: input.planId,
      interval: input.interval,
      currency: input.currency,
      prices: await priceRows(),
      discount,
      discountCode: input.discountCode,
      tax,
      now: isoNow(),
    });
    if (quote.totalMinor === 0) {
      throw new PaymentError(
        'NOTHING_TO_CHARGE',
        'This plan costs nothing in this currency, so it is granted rather than bought.',
        409,
        { planId: input.planId },
      );
    }
    return { quote, planName: plan.name };
  };

  /* -------------------------------------------------------------- checkout */

  const quote = async (input: {
    ownerRef: string;
    planId: string;
    interval: string;
    currency?: string | null;
    discountCode?: string | null;
  }): Promise<QuoteView> => {
    if (!isBillingInterval(input.interval)) {
      throw new PaymentError('INTERVAL_INVALID', 'Choose monthly or yearly billing.', 400);
    }
    await planOrThrow(input.planId);
    const currency = await chooseCurrency(input.planId, input.interval, input.currency);
    const { quote: computed, planName } = await quoteFor({
      ownerRef: input.ownerRef,
      planId: input.planId,
      interval: input.interval,
      currency,
      discountCode:
        input.discountCode === null || input.discountCode === undefined
          ? null
          : input.discountCode.trim().toUpperCase(),
    });
    const providers = await Promise.all(
      (await store.listProviders()).map((settings) => toView(settings)),
    );
    return {
      ...computed,
      planName,
      formatted: formatAmount(computed.totalMinor, computed.currency),
      providers: providers.filter((view) => view.currencies.includes(computed.currency)),
      note: 'The amount is decided by this server from the configured price, discount and tax rows.',
    };
  };

  const checkout = async (input: {
    ownerRef: string;
    planId: string;
    interval: string;
    provider: string;
    currency?: string | null;
    discountCode?: string | null;
    email?: string | null;
    name?: string | null;
    country?: string | null;
    workspaceId?: string | null;
  }): Promise<CheckoutView> => {
    if (!isBillingInterval(input.interval)) {
      throw new PaymentError('INTERVAL_INVALID', 'Choose monthly or yearly billing.', 400);
    }
    if (!isPaymentProvider(input.provider)) {
      throw new PaymentError('PROVIDER_UNKNOWN', 'That payment provider is not supported.', 404);
    }
    await planOrThrow(input.planId);

    const existing = await customer(input.ownerRef);
    const email = (input.email ?? existing?.email ?? '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new PaymentError(
        'EMAIL_REQUIRED',
        'A receipt needs an email address. Add one and try again.',
        400,
      );
    }
    const profile: BillingCustomer = {
      ownerRef: input.ownerRef,
      email,
      name: (input.name ?? existing?.name ?? '').trim().slice(0, 120),
      country:
        (input.country ?? existing?.country ?? null)?.toString().trim().toUpperCase() ?? null,
      updatedAt: isoNow(),
    };
    if (profile.country !== null && !/^[A-Z]{2}$/.test(profile.country)) {
      throw new PaymentError('COUNTRY_INVALID', 'A country is a two-letter code.', 400);
    }
    await store.saveCustomer(profile);

    const currency = await chooseCurrency(input.planId, input.interval, input.currency);
    const { quote: computed } = await quoteFor({
      ownerRef: input.ownerRef,
      planId: input.planId,
      interval: input.interval,
      currency,
      discountCode:
        input.discountCode === null || input.discountCode === undefined
          ? null
          : input.discountCode.trim().toUpperCase(),
    });

    const { adapter, settings } = await adapterFor(input.provider);
    if (!settings.currencies.includes(computed.currency)) {
      throw new PaymentError(
        'CURRENCY_UNSUPPORTED',
        `${settings.displayName} cannot charge ${computed.currency}.`,
        409,
        { provider: settings.provider, currency: computed.currency },
      );
    }

    const reference = newId('vtv');
    const createdAt = isoNow();
    const intent: PaymentIntentRecord = {
      id: newId('pi'),
      ownerRef: input.ownerRef,
      workspaceId: input.workspaceId ?? null,
      planId: computed.planId,
      interval: computed.interval,
      kind: 'initial',
      provider: settings.provider,
      mode: settings.mode,
      currency: computed.currency,
      unitAmountMinor: computed.unitAmountMinor,
      discountMinor: computed.discountMinor,
      discountCode: computed.discountCode,
      taxName: computed.taxName,
      taxRateBps: computed.taxRateBps,
      taxMinor: computed.taxMinor,
      totalMinor: computed.totalMinor,
      reference,
      status: 'open',
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + INTENT_TTL_MS).toISOString(),
      paidAt: null,
    };
    await store.insertIntent(intent);
    await audit('owner', input.ownerRef, 'intent.created', 'customer', reference, {
      planId: intent.planId,
      interval: intent.interval,
      provider: intent.provider,
      totalMinor: intent.totalMinor,
      currency: intent.currency,
    });

    try {
      const session = await adapter.initialize({
        reference,
        amountMinor: intent.totalMinor,
        currency: intent.currency,
        email: profile.email,
        customerName: profile.name === '' ? profile.email : profile.name,
        description: `Veltravia AI ${intent.planId} ${intent.interval}`,
        callbackUrl: `${publicBaseUrl}/#/billing?reference=${encodeURIComponent(reference)}`,
        metadata: { intentId: intent.id, planId: intent.planId, interval: intent.interval },
      });
      if (computed.discountCode !== null) {
        await store.redeemDiscount(computed.discountCode).catch(() => undefined);
      }
      return {
        intentId: intent.id,
        reference,
        checkoutUrl: session.checkoutUrl,
        provider: intent.provider,
        mode: intent.mode,
        amountMinor: intent.totalMinor,
        currency: intent.currency,
        expiresAt: intent.expiresAt,
      };
    } catch (error) {
      await store.updateIntent({ ...intent, status: 'failed' }).catch(() => undefined);
      await audit('owner', input.ownerRef, 'payment.failed', 'system', reference, {
        stage: 'initialise',
        provider: intent.provider,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      throw error;
    }
  };

  /* ----------------------------------------------------------- settlement */

  /**
   * Grants what a verified payment bought. Written so a retry converges: the
   * invoice with this transaction reference is the marker that the grant already
   * happened, so a webhook retried after a partial failure does not buy a second
   * period.
   */
  const grant = async (
    intent: PaymentIntentRecord,
    transaction: PaymentTransactionRecord,
  ): Promise<{ invoice: InvoiceRecord | null; reason: string | null }> => {
    const invoices = await store.listInvoices(intent.ownerRef, { limit: 200 });
    const already = invoices.find(
      (invoice) => invoice.transactionReference === intent.reference && invoice.status === 'paid',
    );
    if (already !== undefined) return { invoice: already, reason: null };

    let reason: string | null = null;
    try {
      const current = await subscriptions.overview(intent.ownerRef);
      const record = current.subscription;
      if (record === null) {
        await subscriptions.assign({
          ownerRef: intent.ownerRef,
          planId: intent.planId,
          actor: 'payments',
          reason: `Paid ${formatAmount(intent.totalMinor, intent.currency)} through ${intent.provider}.`,
          renews: true,
        });
      } else if (record.planId === intent.planId) {
        // Same plan: advance an overdue period, otherwise leave the paid time alone.
        await subscriptions.renew(intent.ownerRef, 'payments');
        const after = await subscriptions.overview(intent.ownerRef);
        if (!after.effective.entitled) {
          await subscriptions.reactivate({
            ownerRef: intent.ownerRef,
            actor: 'payments',
            reason: 'Paid renewal.',
          });
        }
      } else {
        await subscriptions.changePlan({
          ownerRef: intent.ownerRef,
          planId: intent.planId,
          actor: 'payments',
          reason: `Paid for ${intent.planId}.`,
          selfService: false,
        });
      }
      await audit(
        'owner',
        intent.ownerRef,
        'subscription.activated',
        'payments',
        intent.reference,
        {
          planId: intent.planId,
          interval: intent.interval,
          kind: intent.kind,
        },
      );
    } catch (error) {
      // The money arrived but the plan did not change. Say so, keep the record,
      // and let reconciliation finish the job rather than pretending.
      reason =
        error instanceof Error
          ? error.message
          : 'The subscription could not be updated after the payment.';
      await audit('owner', intent.ownerRef, 'payment.reconciled', 'system', intent.reference, {
        stage: 'grant',
        outcome: 'needs-attention',
        reason,
      });
    }

    const paidAt = isoNow();
    const plans = await subscriptions.catalogue();
    const planName = plans.find((plan) => plan.id === intent.planId)?.name ?? intent.planId;
    const buyer = await store.readCustomer(intent.ownerRef).catch(() => null);
    const draft = buildInvoiceDraft({
      quote: {
        planId: intent.planId,
        interval: intent.interval,
        currency: intent.currency,
        unitAmountMinor: intent.unitAmountMinor,
        discountCode: intent.discountCode,
        discountMinor: intent.discountMinor,
        subtotalMinor: intent.unitAmountMinor - intent.discountMinor,
        taxName: intent.taxName,
        taxRateBps: intent.taxRateBps,
        taxMinor: intent.taxMinor,
        totalMinor: intent.totalMinor,
      },
      planName,
      interval: intent.interval,
      customer: {
        name: buyer?.name ?? '',
        email: buyer?.email ?? '',
        address: null,
      },
      issuedAt: paidAt,
      workspaceId: intent.workspaceId,
      provider: intent.provider,
      transactionReference: transaction.providerReference,
      notes: [],
    });
    const sequence = await store.nextInvoiceSequence(invoiceYear(paidAt));
    const invoice: InvoiceRecord = {
      id: newId('inv'),
      number: formatInvoiceNumber(invoiceYear(paidAt), sequence),
      ownerRef: intent.ownerRef,
      workspaceId: intent.workspaceId,
      planId: intent.planId,
      planName: draft.planName,
      interval: intent.interval,
      currency: intent.currency,
      unitAmountMinor: intent.unitAmountMinor,
      discountMinor: intent.discountMinor,
      subtotalMinor: draft.subtotalMinor,
      taxName: intent.taxName,
      taxRateBps: intent.taxRateBps,
      taxMinor: intent.taxMinor,
      totalMinor: intent.totalMinor,
      status: 'paid',
      customerName: draft.customerName,
      customerEmail: draft.customerEmail,
      customerAddress: null,
      issuedAt: paidAt,
      dueAt: paidAt,
      paidAt,
      transactionReference: transaction.providerReference,
      provider: intent.provider,
      notes: draft.notes,
      createdAt: paidAt,
      updatedAt: paidAt,
    };
    const saved = await store.insertInvoice(invoice).catch(() => null);
    if (saved !== null) {
      await audit('owner', intent.ownerRef, 'invoice.paid', 'payments', saved.number, {
        totalMinor: saved.totalMinor,
        currency: saved.currency,
      });
      await notify({
        ownerRef: intent.ownerRef,
        kind: 'invoice-available',
        dedupeKey: `invoice-available:${saved.number}`,
        title: 'Your invoice is ready',
        message: `${saved.number} for ${formatAmount(saved.totalMinor, saved.currency)} is available in Billing.`,
        subjectId: saved.id,
      });
    }
    return { invoice: saved, reason };
  };

  const failTransaction = async (
    intent: PaymentIntentRecord,
    input: {
      status: 'failed' | 'abandoned' | 'pending';
      failureReason: string | null;
      channel: string | null;
      amountMinor: number;
    },
  ): Promise<PaymentTransactionRecord> => {
    const at = isoNow();
    const existing = await store.findTransactionByReference(intent.reference);
    if (existing !== null) {
      return store.updateTransaction({
        ...existing,
        status: input.status,
        failureReason: input.failureReason,
        channel: input.channel ?? existing.channel,
        updatedAt: at,
      });
    }
    const created = await store
      .insertTransaction({
        id: newId('tx'),
        ownerRef: intent.ownerRef,
        intentId: intent.id,
        provider: intent.provider,
        mode: intent.mode,
        providerReference: intent.reference,
        amountMinor: input.amountMinor,
        currency: intent.currency,
        status: input.status,
        kind: intent.kind,
        planId: intent.planId,
        interval: intent.interval,
        verifiedAt: null,
        failureReason: input.failureReason,
        channel: input.channel,
        createdAt: at,
        updatedAt: at,
      })
      .catch(async () => {
        const raced = await store.findTransactionByReference(intent.reference);
        if (raced === null)
          throw new PaymentError('PAYMENT_RECORD_LOST', 'The payment could not be recorded.', 503);
        return raced;
      });
    return created;
  };

  /**
   * Verifies one reference with the provider and grants exactly once.
   *
   * Called from both the redirect (`confirm`) and the webhook, so it has to be
   * safe to call twice: the unique transaction reference is the claim.
   */
  const settle = async (intent: PaymentIntentRecord): Promise<SettleResult> => {
    const existing = await store.findTransactionByReference(intent.reference);

    if (existing !== null && existing.status === 'succeeded') {
      // Finish anything a previous attempt did not (an invoice, a plan change).
      const finished = await grant(intent, existing);
      return {
        status: 'already-paid',
        reference: intent.reference,
        transaction: existing,
        invoice: finished.invoice,
        planId: intent.planId,
        reason: finished.reason,
      };
    }

    const { adapter } = await adapterFor(intent.provider, intent.mode);
    const verified = await adapter.verify(intent.reference);

    if (verified.status !== 'succeeded') {
      const status = verified.status === 'abandoned' ? 'abandoned' : verified.status;
      const transaction = await failTransaction(intent, {
        status,
        failureReason: verified.failureReason ?? `The provider reports ${verified.status}.`,
        channel: verified.channel,
        amountMinor: verified.amountMinor,
      });
      await audit('owner', intent.ownerRef, 'payment.failed', 'system', intent.reference, {
        stage: 'verify',
        outcome: verified.status,
      });
      if (status === 'failed') {
        await notify({
          ownerRef: intent.ownerRef,
          kind: 'payment-failed',
          dedupeKey: `payment-failed:${intent.reference}`,
          title: 'A payment did not go through',
          message: `${formatAmount(intent.totalMinor, intent.currency)} could not be collected. Nothing was charged and your plan is unchanged.`,
          subjectId: intent.reference,
        });
      }
      return {
        status: status === 'failed' ? 'failed' : 'pending',
        reference: intent.reference,
        transaction,
        invoice: null,
        planId: intent.planId,
        reason: verified.failureReason,
      };
    }

    if (verified.currency !== intent.currency || verified.amountMinor !== intent.totalMinor) {
      // The provider took an amount this server did not decide. Never grant it.
      await failTransaction(intent, {
        status: 'failed',
        failureReason: `Amount mismatch: expected ${intent.totalMinor} ${intent.currency}, provider reported ${verified.amountMinor} ${verified.currency}.`,
        channel: verified.channel,
        amountMinor: verified.amountMinor,
      });
      await audit('owner', intent.ownerRef, 'payment.reconciled', 'system', intent.reference, {
        outcome: 'amount-mismatch',
        expectedMinor: intent.totalMinor,
        expectedCurrency: intent.currency,
        reportedMinor: verified.amountMinor,
        reportedCurrency: verified.currency,
      });
      await notify({
        ownerRef: intent.ownerRef,
        kind: 'payment-failed',
        dedupeKey: `payment-mismatch:${intent.reference}`,
        title: 'A payment needs attention',
        message:
          'The amount the provider reported did not match this order, so no plan was activated. Support has the details.',
        subjectId: intent.reference,
      });
      return {
        status: 'mismatch',
        reference: intent.reference,
        transaction: null,
        invoice: null,
        planId: intent.planId,
        reason: 'The amount or currency did not match this order.',
      };
    }

    const at = isoNow();
    const transaction: PaymentTransactionRecord = {
      id: newId('tx'),
      ownerRef: intent.ownerRef,
      intentId: intent.id,
      provider: intent.provider,
      mode: intent.mode,
      providerReference: intent.reference,
      amountMinor: verified.amountMinor,
      currency: verified.currency,
      status: 'succeeded',
      kind: intent.kind,
      planId: intent.planId,
      interval: intent.interval,
      verifiedAt: at,
      failureReason: null,
      channel: verified.channel,
      createdAt: at,
      updatedAt: at,
    };

    let recorded: PaymentTransactionRecord;
    try {
      recorded = await store.insertTransaction(transaction);
    } catch (error) {
      // Another delivery won the race. That is a success, not a failure.
      const raced = await store.findTransactionByReference(intent.reference);
      if (raced !== null && raced.status === 'succeeded') {
        const finished = await grant(intent, raced);
        return {
          status: 'already-paid',
          reference: intent.reference,
          transaction: raced,
          invoice: finished.invoice,
          planId: intent.planId,
          reason: finished.reason,
        };
      }
      throw error;
    }

    if (intent.status === 'open') {
      await store.updateIntent({ ...intent, status: 'paid', paidAt: at }).catch(() => undefined);
    }

    if (verified.authorization !== null && verified.authorization.reusable) {
      const method: PaymentMethodRecord = {
        id: newId('pm'),
        ownerRef: intent.ownerRef,
        provider: intent.provider,
        mode: intent.mode,
        authorizationCode: verified.authorization.code,
        brand: verified.authorization.brand,
        last4: verified.authorization.last4,
        expMonth: verified.authorization.expMonth,
        expYear: verified.authorization.expYear,
        reusable: true,
        createdAt: at,
      };
      await store.savePaymentMethod(method).catch(() => undefined);
    }

    const granted = await grant(intent, recorded);

    await audit('owner', intent.ownerRef, 'payment.verified', 'system', intent.reference, {
      provider: intent.provider,
      amountMinor: verified.amountMinor,
      currency: verified.currency,
    });
    await notify({
      ownerRef: intent.ownerRef,
      kind: 'payment-succeeded',
      dedupeKey: `payment-succeeded:${intent.reference}`,
      title: 'Payment received',
      message: `${formatAmount(verified.amountMinor, verified.currency)} received. Your ${intent.planId} plan is active.`,
      subjectId: intent.reference,
    });

    return {
      status: 'paid',
      reference: intent.reference,
      transaction: recorded,
      invoice: granted.invoice,
      planId: intent.planId,
      reason: granted.reason,
    };
  };

  const confirm = async (input: { ownerRef: string; reference: string }): Promise<SettleResult> => {
    const intent = await store.findIntentByReference(input.reference);
    if (intent === null || intent.ownerRef !== input.ownerRef) {
      throw new PaymentError(
        'CHECKOUT_NOT_FOUND',
        'That payment reference does not belong to a checkout on this account.',
        404,
      );
    }
    return settle(intent);
  };

  /* -------------------------------------------------------------- webhooks */

  const handleWebhook = async (input: {
    provider: string;
    mode?: string;
    rawBody: string;
    headers: Readonly<Record<string, string | string[] | undefined>>;
  }): Promise<{ status: number; body: Record<string, unknown> }> => {
    if (!isPaymentProvider(input.provider)) {
      return { status: 404, body: { received: false, reason: 'unknown-provider' } };
    }
    const mode = input.mode === 'live' || input.mode === 'test' ? input.mode : undefined;
    let resolved: { adapter: ProviderAdapter; settings: ProviderSettings };
    try {
      resolved = await adapterFor(input.provider, mode);
    } catch {
      return { status: 404, body: { received: false, reason: 'provider-not-configured' } };
    }

    const flatHeaders: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(input.headers)) {
      flatHeaders[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }

    const verdict = resolved.adapter.verifyWebhook({
      rawBody: input.rawBody,
      headers: flatHeaders,
    });

    let event: NormalizedEvent;
    try {
      event = resolved.adapter.parseWebhook({ rawBody: input.rawBody });
    } catch {
      event = {
        eventId: '',
        eventType: 'unparseable',
        reference: null,
        amountMinor: null,
        currency: null,
        status: 'unknown',
        occurredAt: null,
        raw: null,
      };
    }

    const decision = decideWebhook({
      provider: resolved.settings.provider,
      event,
      signatureValid: verdict.valid,
      signatureReason: verdict.reason,
      now: isoNow(),
    });

    /*
     * A refused delivery is kept as evidence but must not hold the canonical
     * dedupe key: a provider whose secret was set up wrong, and fixed, would
     * otherwise have every retry of that event refused forever.
     */
    const recordId = newId('ev');
    const record: PaymentEventRecord = {
      id: recordId,
      ownerRef: null,
      provider: resolved.settings.provider,
      mode: resolved.settings.mode,
      eventType: event.eventType,
      dedupeKey:
        decision.action === 'reject'
          ? `rejected:${decision.dedupeKey}:${recordId}`
          : decision.dedupeKey,
      reference: event.reference,
      signatureValid: verdict.valid,
      status:
        decision.action === 'reject'
          ? 'rejected'
          : decision.action === 'ignore'
            ? 'ignored'
            : 'received',
      note: decision.reason,
      attempts: 1,
      receivedAt: isoNow(),
      processedAt: null,
    };

    const inserted = await store.insertEvent(record);
    if (!inserted.created) {
      // A redelivery. Recording it as a duplicate is the whole point of the row,
      // and doing nothing else is what stops a retry buying a second period.
      await audit('platform', '', 'webhook.processed', 'provider', decision.dedupeKey, {
        outcome: 'duplicate',
      });
      return {
        status: 200,
        body: {
          received: true,
          duplicate: true,
          note: 'This delivery had already been recorded and was not acted on again.',
        },
      };
    }

    if (decision.action === 'reject') {
      await store
        .updateEvent({ ...record, processedAt: isoNow(), note: decision.reason })
        .catch(() => undefined);
      await audit('platform', '', 'webhook.rejected', 'provider', decision.dedupeKey, {
        reason: decision.reason,
      });
      return { status: 401, body: { received: false, reason: decision.reason } };
    }

    if (decision.action === 'ignore' || event.reference === null) {
      await store
        .updateEvent({ ...record, processedAt: isoNow(), note: decision.reason })
        .catch(() => undefined);
      return { status: 200, body: { received: true, ignored: true, note: decision.reason } };
    }

    const intent = await store.findIntentByReference(event.reference);
    if (intent === null) {
      await store
        .updateEvent({
          ...record,
          status: 'ignored',
          processedAt: isoNow(),
          note: 'No checkout on this deployment issued that reference.',
        })
        .catch(() => undefined);
      return {
        status: 200,
        body: { received: true, ignored: true, note: 'unknown reference' },
      };
    }

    try {
      const result = await runScoped(intent.ownerRef, () => settle(intent));
      await store
        .updateEvent({
          ...record,
          ownerRef: intent.ownerRef,
          status: 'processed',
          processedAt: isoNow(),
          note: `${result.status}${result.reason === null ? '' : `: ${result.reason}`}`,
        })
        .catch(() => undefined);
      await audit(
        'platform',
        intent.ownerRef,
        'webhook.processed',
        'provider',
        decision.dedupeKey,
        {
          outcome: result.status,
        },
      );
      return { status: 200, body: { received: true, outcome: result.status } };
    } catch (error) {
      await store
        .updateEvent({
          ...record,
          ownerRef: intent.ownerRef,
          status: 'failed',
          note: error instanceof Error ? error.message : 'The event could not be processed.',
          processedAt: isoNow(),
        })
        .catch(() => undefined);
      // 503 tells the provider to try again; the transaction reference still
      // guarantees the retry cannot grant a second period.
      return { status: 503, body: { received: false, retry: true } };
    }
  };

  /* -------------------------------------------------------------- overview */

  const overview = async (ownerRef: string): Promise<BillingOverview> => {
    const subscriptionOverview = await subscriptions.overview(ownerRef);
    const record = subscriptionOverview.subscription;
    const effective = subscriptionOverview.effective;
    const [transactions, invoices, refunds, notifications, method, providerRows, prices] =
      await Promise.all([
        store.listTransactions(ownerRef, { limit: 25 }),
        store.listInvoices(ownerRef, { limit: 25 }),
        store.listRefunds(ownerRef, 25),
        store.listNotifications(ownerRef, { limit: 20 }),
        store.readPaymentMethod(ownerRef),
        store.listProviders(),
        store.listPrices(),
      ]);
    const taxes = await store.listTaxes();
    const buyer = await customer(ownerRef);

    return {
      plan: {
        id: effective.plan.id,
        name: effective.plan.name,
        status: effective.status,
        entitled: effective.entitled,
        interval:
          record === null
            ? null
            : planIntervalOf(record.currentPeriodStart, record.currentPeriodEnd),
        currentPeriodEnd: record?.currentPeriodEnd ?? null,
        renews: record?.renews ?? false,
        cancelAtPeriodEnd: record?.cancelAtPeriodEnd ?? false,
        daysRemaining: subscriptionOverview.daysRemaining,
      },
      subscription: {
        status: effective.status,
        source: effective.source,
        reason: effective.reason,
        monthlyMessageCredits: effective.plan.monthlyMessageCredits,
        monthlyIntegrationCredits: effective.plan.monthlyIntegrationCredits,
      },
      prices: priceBookView(prices).map((row) => ({
        ...row,
        planName:
          subscriptionOverview.plans.find((plan) => plan.id === row.planId)?.name ?? row.planId,
      })),
      providers: providerRows.map(toView),
      paymentMethod:
        method === null
          ? null
          : {
              brand: method.brand,
              last4: method.last4,
              expMonth: method.expMonth,
              expYear: method.expYear,
              provider: method.provider,
              reusable: method.reusable,
            },
      transactions,
      invoices,
      refunds,
      notifications,
      policies: {
        refund: { policy: refundPolicy, note: refundEffect(refundPolicy).note },
        grace: gracePolicy,
        taxConfigured: taxes.some((tax) => tax.active && tax.rateBps > 0),
        topUps: false,
      },
      customer: buyer === null ? null : { email: buyer.email, name: buyer.name },
      durable,
      note: 'A subscription is a record of a verified payment. Credits are a ceiling the plan grants, never a balance this screen can add to.',
    };
  };

  function planIntervalOf(start: string, end: string): BillingInterval {
    const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    return days > 300 ? 'yearly' : 'monthly';
  }

  const invoice = async (ownerRef: string, invoiceId: string): Promise<InvoiceRecord> => {
    const found = await store.readInvoice(invoiceId);
    if (found === null || found.ownerRef !== ownerRef) {
      throw new PaymentError('INVOICE_NOT_FOUND', 'There is no such invoice on this account.', 404);
    }
    return found;
  };

  const invoicePdf = async (
    ownerRef: string,
    invoiceId: string,
    kind: 'invoice' | 'receipt' = 'invoice',
  ): Promise<{ bytes: Buffer; filename: string }> => {
    const found = await invoice(ownerRef, invoiceId);
    const document = kind === 'receipt' ? receiptDocument(found) : invoiceDocument(found);
    return {
      bytes: renderPdf(document),
      filename: `${found.number}${kind === 'receipt' ? '-receipt' : ''}.pdf`,
    };
  };

  const markNotificationsRead = (ownerRef: string, ids?: readonly string[]): Promise<number> =>
    store.markNotificationsRead(ownerRef, ids);

  /* -------------------------------------------------------------- renewals */

  const renewalsDue = async (
    limit = 50,
  ): Promise<readonly { ownerRef: string; periodEnd: string }[]> => {
    const rows = await subscriptions.adminSubscriptions({ limit: 200 });
    const at = now().getTime();
    return rows
      .filter(
        (row) =>
          row.renews &&
          !row.cancelAtPeriodEnd &&
          (row.status === 'active' || row.status === 'past_due') &&
          Date.parse(row.currentPeriodEnd) <= at,
      )
      .slice(0, limit)
      .map((row) => ({ ownerRef: row.ownerRef, periodEnd: row.currentPeriodEnd }));
  };

  /**
   * One renewal, and it never charges without a stored authorization the customer
   * created by buying a subscription. Without one it produces a checkout link and
   * says so, which is the manual renewal flow a provider without recurring
   * support needs.
   */
  const chargeRenewal = async (input: {
    ownerRef: string;
    actor: string;
  }): Promise<{ charged: boolean; checkoutUrl: string | null; reason: string }> => {
    const view = await subscriptions.overview(input.ownerRef);
    const record = view.subscription;
    if (record === null) {
      return { charged: false, checkoutUrl: null, reason: 'There is no subscription to renew.' };
    }
    if (!record.renews || record.cancelAtPeriodEnd) {
      return {
        charged: false,
        checkoutUrl: null,
        reason: 'This subscription is not set to renew.',
      };
    }
    if (Date.parse(record.currentPeriodEnd) > now().getTime()) {
      // Charging now would collect money for time already paid for.
      return {
        charged: false,
        checkoutUrl: null,
        reason: `The current period runs until ${record.currentPeriodEnd.slice(0, 10)}, so there is nothing to renew yet.`,
      };
    }
    const interval = planIntervalOf(record.currentPeriodStart, record.currentPeriodEnd);
    const prices = await store.listPrices();
    const price = prices.find(
      (row) => row.active && row.planId === record.planId && row.interval === interval,
    );
    if (price === undefined) {
      return {
        charged: false,
        checkoutUrl: null,
        reason: 'That plan has no price configured, so no renewal can be charged.',
      };
    }

    const method = await store.readPaymentMethod(input.ownerRef).catch(() => null);

    if (method !== null && method.reusable) {
      const { adapter } = await adapterFor(method.provider, method.mode);
      if (adapter.capabilities.recurring) {
        const buyer = await customer(input.ownerRef);
        const reference = newId('vtv');
        const at = isoNow();
        const intent: PaymentIntentRecord = {
          id: newId('pi'),
          ownerRef: input.ownerRef,
          workspaceId: null,
          planId: record.planId,
          interval,
          kind: 'renewal',
          provider: method.provider,
          mode: method.mode,
          currency: price.currency,
          unitAmountMinor: price.amountMinor,
          discountMinor: 0,
          discountCode: null,
          taxName: null,
          taxRateBps: 0,
          taxMinor: 0,
          totalMinor: price.amountMinor,
          reference,
          status: 'open',
          createdAt: at,
          expiresAt: new Date(Date.parse(at) + INTENT_TTL_MS).toISOString(),
          paidAt: null,
        };
        const created = await runScoped(input.ownerRef, () => store.insertIntent(intent));
        const charged = await adapter
          .chargeAuthorization({
            reference,
            amountMinor: created.totalMinor,
            currency: created.currency,
            email: buyer?.email ?? '',
            authorizationCode: method.authorizationCode,
            description: `Veltravia AI ${record.planId} renewal`,
            metadata: { intentId: created.id, renewal: 'true' },
          })
          .catch((error: unknown) => {
            throw new PaymentError(
              'RENEWAL_CHARGE_FAILED',
              error instanceof Error ? error.message : 'The renewal charge failed.',
              402,
            );
          });
        if (charged.status === 'succeeded') {
          const result = await runScoped(input.ownerRef, () => settle(created));
          if (result.status === 'paid' || result.status === 'already-paid') {
            await notify({
              ownerRef: input.ownerRef,
              kind: 'subscription-renewed',
              dedupeKey: `renewed:${record.currentPeriodEnd}`,
              title: 'Subscription renewed',
              message: `${formatAmount(created.totalMinor, created.currency)} renewed your ${record.planId} plan.`,
              subjectId: created.reference,
            });
            await audit(
              'owner',
              input.ownerRef,
              'subscription.renewed',
              input.actor,
              created.reference,
              {
                planId: record.planId,
              },
            );
            return {
              charged: true,
              checkoutUrl: null,
              reason: `Renewed through ${method.provider}.`,
            };
          }
        }
        return {
          charged: false,
          checkoutUrl: null,
          reason: 'The renewal charge did not succeed, so the plan was left as it was.',
        };
      }
    }

    // No reusable authorization, or a provider that cannot charge one: a manual
    // renewal the customer completes. Never a silent charge, never a silent lapse.
    const currency = price.currency;
    const link = `${publicBaseUrl}/#/billing?renew=${encodeURIComponent(record.planId)}&interval=${interval}`;
    await notify({
      ownerRef: input.ownerRef,
      kind: 'renewal-reminder',
      dedupeKey: `renewal-due:${record.currentPeriodEnd}`,
      title: 'Your subscription is due to renew',
      message: `Add a payment to keep the ${record.planId} plan. Nothing has been charged and nothing was deleted.`,
      subjectId: null,
    });
    return {
      charged: false,
      checkoutUrl: link,
      reason: `No stored authorization can be charged, so a renewal link was produced in ${currency}.`,
    };
  };

  const sendRenewalReminders = async (): Promise<{ sent: number }> => {
    const rows = await subscriptions.adminSubscriptions({ limit: 200 });
    const at = now().getTime();
    let sent = 0;
    for (const row of rows) {
      if (row.status !== 'active' || row.cancelAtPeriodEnd) continue;
      const until = Date.parse(row.currentPeriodEnd) - at;
      if (until <= 0) continue;
      if (until > gracePolicy.reminderDays * 86_400_000) continue;
      const created = await notify({
        ownerRef: row.ownerRef,
        kind: 'renewal-reminder',
        dedupeKey: `renewal-soon:${row.currentPeriodEnd}`,
        title: 'Renewal coming up',
        message: `Your ${row.planId} plan renews on ${row.currentPeriodEnd.slice(0, 10)}.`,
        subjectId: null,
      });
      if (created) sent += 1;
    }
    return { sent };
  };

  /* --------------------------------------------------------------- refunds */

  const refund = async (input: {
    transactionId: string;
    amountMinor?: number;
    reason: string;
    actor: string;
    approve: boolean;
    note?: string | null;
  }): Promise<RefundRecord> => {
    const reason = input.reason.trim();
    if (reason.length < 4) {
      throw new PaymentError(
        'REFUND_REASON_REQUIRED',
        'A refund needs a reason of 4 characters or more.',
        400,
      );
    }
    if (!input.approve) {
      throw new PaymentError(
        'REFUND_NOT_APPROVED',
        'A refund needs an explicit approval. Nothing was refunded.',
        403,
      );
    }
    // The owner comes from the transaction, never from the request, so a refund
    // cannot be pointed at somebody else's account by a body field.
    const transaction = await store.readTransaction(input.transactionId);
    if (transaction === null) {
      throw new PaymentError('TRANSACTION_NOT_FOUND', 'There is no such payment.', 404);
    }
    const ownerRef = transaction.ownerRef;
    if (transaction.status !== 'succeeded' && transaction.status !== 'partially_refunded') {
      throw new PaymentError(
        'REFUND_NOT_POSSIBLE',
        'Only a payment that succeeded can be refunded.',
        409,
      );
    }
    const existing = await store.listRefundsForTransaction(transaction.id);
    const alreadyRefunded = existing
      .filter((row) => row.status !== 'failed')
      .reduce((total, row) => total + row.amountMinor, 0);
    const remaining = transaction.amountMinor - alreadyRefunded;
    if (remaining <= 0) {
      throw new PaymentError(
        'REFUND_EXHAUSTED',
        'That payment has already been refunded in full.',
        409,
      );
    }
    const amountMinor = input.amountMinor ?? remaining;
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new PaymentError(
        'REFUND_AMOUNT_INVALID',
        'A refund is a whole number of minor units.',
        400,
      );
    }
    if (amountMinor > remaining) {
      throw new PaymentError(
        'REFUND_TOO_LARGE',
        `Only ${formatAmount(remaining, transaction.currency)} of that payment is left to refund.`,
        409,
        { remainingMinor: remaining },
      );
    }

    const { adapter } = await adapterFor(transaction.provider, transaction.mode);
    if (!adapter.capabilities.refunds) {
      throw new PaymentError(
        'REFUND_UNSUPPORTED',
        `${transaction.provider} cannot issue refunds in this build.`,
        409,
      );
    }
    if (!adapter.capabilities.partialRefunds && amountMinor !== remaining) {
      throw new PaymentError(
        'REFUND_PARTIAL_UNSUPPORTED',
        `${transaction.provider} only refunds the full amount.`,
        409,
      );
    }

    const at = isoNow();
    const requested: RefundRecord = {
      id: newId('rf'),
      ownerRef: ownerRef,
      transactionId: transaction.id,
      provider: transaction.provider,
      mode: transaction.mode,
      amountMinor,
      currency: transaction.currency,
      reason,
      status: 'requested',
      providerReference: null,
      requestedBy: input.actor,
      approvedBy: input.actor,
      note: input.note ?? null,
      createdAt: at,
      updatedAt: at,
    };
    const stored = await runScoped(ownerRef, () => store.insertRefund(requested));
    await audit('owner', ownerRef, 'refund.requested', input.actor, stored.id, {
      transactionId: transaction.id,
      amountMinor,
      currency: transaction.currency,
      reason,
    });

    const result = await adapter
      .refund({
        providerReference: transaction.providerReference,
        amountMinor,
        currency: transaction.currency,
        reason,
      })
      .catch(async (error: unknown) => {
        await store
          .updateRefund({ ...stored, status: 'failed', updatedAt: isoNow() })
          .catch(() => undefined);
        await audit('owner', ownerRef, 'refund.failed', input.actor, stored.id, {
          reason: error instanceof Error ? error.message : 'unknown',
        });
        throw error;
      });

    const settledRefund = await store.updateRefund({
      ...stored,
      status: result.status,
      providerReference: result.providerReference,
      updatedAt: isoNow(),
    });

    if (result.status === 'failed') {
      await notify({
        ownerRef: ownerRef,
        kind: 'refund-completed',
        dedupeKey: `refund-failed:${stored.id}`,
        title: 'A refund did not complete',
        message: 'The provider refused the refund. Nothing changed on your plan.',
        subjectId: stored.id,
      });
      await audit('owner', ownerRef, 'refund.failed', input.actor, stored.id, {});
      return settledRefund;
    }

    const totalRefunded = alreadyRefunded + amountMinor;
    await store
      .updateTransaction({
        ...transaction,
        status: totalRefunded >= transaction.amountMinor ? 'refunded' : 'partially_refunded',
        updatedAt: isoNow(),
      })
      .catch(() => undefined);

    await audit('owner', ownerRef, 'refund.succeeded', input.actor, stored.id, {
      amountMinor,
      currency: transaction.currency,
      providerReference: result.providerReference,
    });

    const effect = refundEffect(refundPolicy);
    if (!effect.leavesSubscriptionAlone && totalRefunded >= transaction.amountMinor) {
      try {
        if (effect.cancelImmediately) {
          await subscriptions.cancel({
            ownerRef: ownerRef,
            actor: input.actor,
            reason: `Refund: ${reason}`,
            immediate: true,
          });
        } else {
          await subscriptions.cancel({
            ownerRef: ownerRef,
            actor: input.actor,
            reason: `Refund: ${reason}`,
            immediate: false,
          });
        }
      } catch {
        // A refund is never blocked by the subscription lane refusing a change.
      }
    }

    await notify({
      ownerRef: ownerRef,
      kind: 'refund-completed',
      dedupeKey: `refund-completed:${stored.id}`,
      title: 'Refund issued',
      message: `${formatAmount(amountMinor, transaction.currency)} was refunded. ${effect.note}`,
      subjectId: stored.id,
    });

    return settledRefund;
  };

  /* ---------------------------------------------------------- operator ops */

  const reconcile = async (input: {
    actor: string;
    limit?: number;
  }): Promise<{
    checked: number;
    verified: number;
    failed: number;
    expiredIntents: number;
  }> => {
    const pending = await store.listAllTransactions({
      status: 'pending',
      limit: input.limit ?? 50,
    });
    let verified = 0;
    let failed = 0;
    for (const transaction of pending) {
      const intent = await store.readIntent(transaction.intentId);
      if (intent === null) continue;
      try {
        const result = await runScoped(intent.ownerRef, () => settle(intent));
        if (result.status === 'paid' || result.status === 'already-paid') verified += 1;
        if (result.status === 'failed' || result.status === 'mismatch') failed += 1;
      } catch {
        failed += 1;
      }
    }
    await audit('platform', '', 'payment.reconciled', input.actor, 'reconcile', {
      checked: pending.length,
      verified,
      failed,
    });
    return { checked: pending.length, verified, failed, expiredIntents: 0 };
  };

  return {
    durable,
    refundPolicy,
    ensure,
    async providers(): Promise<readonly ProviderView[]> {
      return (await store.listProviders()).map(toView);
    },
    prices: () => store.listPrices(),
    discounts: () => store.listDiscounts(),
    taxes: () => store.listTaxes(),
    quote,
    checkout,
    confirm,
    overview,
    invoice,
    invoicePdf,
    markNotificationsRead,
    handleWebhook,
    renewalsDue,
    chargeRenewal,
    sendRenewalReminders,
    async configureProvider(input) {
      if (!isPaymentProvider(input.provider)) {
        throw new PaymentError('PROVIDER_UNKNOWN', 'That payment provider is not supported.', 404);
      }
      const mode: PaymentMode =
        input.mode === 'live' || input.mode === 'test' ? input.mode : DEFAULT_MODE;
      const existing = await store.readProvider(input.provider, mode);
      const capabilities = capabilitiesFor(input.provider);
      const next: ProviderSettings = {
        provider: input.provider,
        displayName: input.displayName ?? existing?.displayName ?? PROVIDER_NAMES[input.provider],
        enabled: input.enabled ?? existing?.enabled ?? false,
        mode,
        publicKey: input.publicKey ?? existing?.publicKey ?? null,
        secretRefs: {
          secretKeyEnv:
            input.secretKeyEnv ??
            existing?.secretRefs.secretKeyEnv ??
            DEFAULT_SECRET_REFS[input.provider].secretKeyEnv,
          webhookSecretEnv:
            input.webhookSecretEnv ??
            existing?.secretRefs.webhookSecretEnv ??
            DEFAULT_SECRET_REFS[input.provider].webhookSecretEnv,
        },
        currencies: input.currencies ?? existing?.currencies ?? [...capabilities.currencies],
        capabilities,
        version: (existing?.version ?? 0) + 1,
        updatedAt: isoNow(),
        updatedBy: input.actor,
      };
      if (next.enabled && readSecret(next.secretRefs.secretKeyEnv) === '') {
        throw new PaymentError(
          'PROVIDER_NOT_CONFIGURED',
          `Set ${next.secretRefs.secretKeyEnv} before enabling ${next.displayName}.`,
          409,
        );
      }
      const saved = await store.saveProvider(next);
      await audit(
        'platform',
        '',
        next.enabled ? 'provider.configured' : 'provider.disabled',
        input.actor,
        input.provider,
        {
          mode,
          enabled: saved.enabled,
          currencies: saved.currencies,
        },
      );
      return saved;
    },
    async savePrice(input) {
      const normalized = normalizePriceDraft(input.draft);
      const plans = await subscriptions.catalogue();
      if (!plans.some((plan) => plan.id === normalized.planId)) {
        throw new PaymentError('PLAN_UNAVAILABLE', 'That plan does not exist.', 404);
      }
      const existing = (await store.listPrices()).find(
        (row) =>
          row.planId === normalized.planId &&
          row.interval === normalized.interval &&
          row.currency === normalized.currency,
      );
      const saved = await store.savePrice({
        id: existing?.id ?? newId('pv'),
        planId: normalized.planId,
        interval: normalized.interval,
        currency: normalized.currency,
        amountMinor: normalized.amountMinor,
        active: normalized.active,
        version: (existing?.version ?? 0) + 1,
        createdAt: existing?.createdAt ?? isoNow(),
        updatedAt: isoNow(),
        updatedBy: input.actor,
      });
      await audit(
        'platform',
        '',
        existing === undefined ? 'price.created' : 'price.updated',
        input.actor,
        `${saved.planId}/${saved.interval}/${saved.currency}`,
        { amountMinor: saved.amountMinor },
      );
      return saved;
    },
    async saveDiscount(input) {
      const normalized = normalizeDiscountDraft(input.draft);
      const existing = await store.readDiscount(normalized.code);
      const saved = await store.saveDiscount({
        ...normalized,
        redemptions: existing?.redemptions ?? 0,
        createdAt: existing?.createdAt ?? isoNow(),
        updatedAt: isoNow(),
        updatedBy: input.actor,
      });
      await audit('platform', '', 'discount.created', input.actor, saved.code, {
        percentOff: saved.percentOff,
        amountOffMinor: saved.amountOffMinor,
      });
      return saved;
    },
    async saveTax(input) {
      const normalized = normalizeTaxDraft(input.draft);
      const existing = (await store.listTaxes()).find(
        (row) => row.country === normalized.country && row.active,
      );
      const saved = await store.saveTax({
        id: existing?.id ?? newId('tax'),
        ...normalized,
        createdAt: existing?.createdAt ?? isoNow(),
        updatedAt: isoNow(),
        updatedBy: input.actor,
      });
      await audit('platform', '', 'tax.configured', input.actor, saved.id, {
        name: saved.name,
        rateBps: saved.rateBps,
        country: saved.country,
      });
      return saved;
    },
    refund,
    reconcile,
    events: (limit = 50, status) =>
      store.listEvents({ limit, ...(status === undefined ? {} : { status }) }),
    transactions: (filter) =>
      store.listAllTransactions({
        ...(filter?.status === undefined
          ? {}
          : { status: filter.status as PaymentTransactionRecord['status'] }),
        ...(filter?.provider === undefined || !isPaymentProvider(filter.provider)
          ? {}
          : { provider: filter.provider }),
        limit: filter?.limit ?? 100,
      }),
    audit: (ownerRef, limit) => store.listAudit(ownerRef, limit),
    platformAudit: (limit) => store.listPlatformAudit(limit),
  };
}

/**
 * Runs a write for another account inside that account's owner scope.
 *
 * The webhook and the operator surface both act on somebody else's money, and the
 * repositories refuse a write filed under the calling owner. This is the same
 * mechanism Step 60 uses, kept in one place so the intent is visible.
 */
function runScoped<T>(ownerRef: string, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(runWithOwner(ownerRef, fn));
}
