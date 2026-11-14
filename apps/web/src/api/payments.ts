import { runtimeConfig } from '../config/runtime-config.js';
import { apiRequest } from './client';

/**
 * Typed client for billing (Step 61).
 *
 * Two rules shape this file:
 *
 *  - **Nothing here decides an amount.** A quote is asked for and displayed; the
 *    checkout body names a plan, an interval and a provider. If a browser could
 *    set the price, a browser could buy the top plan for a penny.
 *  - **A redirect is not a receipt.** `confirmPayment` sends the reference back
 *    and the server asks the provider. The page shows what the server answers,
 *    never what the URL says.
 */

export type BillingInterval = 'monthly' | 'yearly';
export type PaymentProviderId = 'paystack' | 'flutterwave' | 'monnify';
export type PaymentStatus =
  'pending' | 'succeeded' | 'failed' | 'abandoned' | 'refunded' | 'partially_refunded';
export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'failed' | 'cancelled' | 'refunded';

export interface ProviderView {
  readonly provider: PaymentProviderId;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly mode: string;
  readonly configured: boolean;
  readonly publicKey: string | null;
  readonly currencies: readonly string[];
  readonly capabilities: {
    readonly recurring: boolean;
    readonly hostedCheckout: boolean;
    readonly refunds: boolean;
    readonly partialRefunds: boolean;
    readonly webhooks: boolean;
  };
}

export interface TransactionView {
  readonly id: string;
  readonly provider: PaymentProviderId;
  readonly providerReference: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: PaymentStatus;
  readonly kind: string;
  readonly planId: string;
  readonly interval: BillingInterval;
  readonly verifiedAt: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
}

export interface InvoiceView {
  readonly id: string;
  readonly number: string;
  readonly planName: string;
  readonly interval: BillingInterval;
  readonly currency: string;
  readonly unitAmountMinor: number;
  readonly discountMinor: number;
  readonly subtotalMinor: number;
  readonly taxName: string | null;
  readonly taxRateBps: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly status: InvoiceStatus;
  readonly issuedAt: string;
  readonly paidAt: string | null;
  readonly transactionReference: string | null;
  readonly provider: PaymentProviderId | null;
  readonly customerEmail: string;
}

export interface RefundView {
  readonly id: string;
  readonly provider: PaymentProviderId;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: string;
  readonly status: 'requested' | 'pending' | 'succeeded' | 'failed';
  readonly createdAt: string;
}

export interface NotificationView {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly message: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface PriceView {
  readonly planId: string;
  readonly planName: string;
  readonly currency: string;
  readonly monthly: number | null;
  readonly yearly: number | null;
  readonly yearlySavingPercent: number | null;
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
  readonly prices: readonly PriceView[];
  readonly providers: readonly ProviderView[];
  readonly paymentMethod: {
    readonly brand: string | null;
    readonly last4: string | null;
    readonly expMonth: string | null;
    readonly expYear: string | null;
    readonly provider: PaymentProviderId;
    readonly reusable: boolean;
  } | null;
  readonly transactions: readonly TransactionView[];
  readonly invoices: readonly InvoiceView[];
  readonly refunds: readonly RefundView[];
  readonly notifications: readonly NotificationView[];
  readonly policies: {
    readonly refund: { readonly policy: string; readonly note: string };
    readonly grace: { readonly days: number; readonly reminderDays: number };
    readonly taxConfigured: boolean;
    readonly topUps: false;
  };
  readonly customer: { readonly email: string; readonly name: string } | null;
  readonly durable: boolean;
  readonly note: string;
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
  readonly mode: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly expiresAt: string;
}

export interface SettleView {
  readonly status: 'paid' | 'already-paid' | 'failed' | 'pending' | 'mismatch';
  readonly reference: string;
  readonly planId: string | null;
  readonly reason: string | null;
  readonly transaction: TransactionView | null;
  readonly invoice: InvoiceView | null;
}

export const getBilling = (): Promise<BillingOverview> =>
  apiRequest<BillingOverview>('/api/payments');

export const quote = (input: {
  planId: string;
  interval: BillingInterval;
  currency?: string | null;
  discountCode?: string | null;
}): Promise<QuoteView> =>
  apiRequest<QuoteView>('/api/payments/quote', { method: 'POST', body: input });

export const startCheckout = (input: {
  planId: string;
  interval: BillingInterval;
  provider: PaymentProviderId;
  currency?: string | null;
  discountCode?: string | null;
  email: string;
  name?: string | null;
  country?: string | null;
}): Promise<CheckoutView> =>
  apiRequest<CheckoutView>('/api/payments/checkout', { method: 'POST', body: input });

export const confirmPayment = (reference: string): Promise<SettleView> =>
  apiRequest<SettleView>('/api/payments/confirm', { method: 'POST', body: { reference } });

export const renewSubscription = (): Promise<{
  charged: boolean;
  checkoutUrl: string | null;
  reason: string;
}> => apiRequest('/api/payments/renew', { method: 'POST', body: {} });

export const markNotificationsRead = (ids?: readonly string[]): Promise<{ marked: number }> =>
  apiRequest<{ marked: number }>('/api/payments/notifications/read', {
    method: 'POST',
    body: ids === undefined ? {} : { ids },
  });

export const invoicePdfUrl = (invoiceId: string, kind: 'invoice' | 'receipt' = 'invoice'): string =>
  `${runtimeConfig().apiBaseUrl}/api/payments/invoices/${encodeURIComponent(invoiceId)}/pdf?kind=${kind}`;
