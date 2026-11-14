/**
 * Payment vocabulary (Step 61).
 *
 * This package is the *shape* of a payment system and the rules that do not need
 * a database: money, prices, provider adapters, webhook verification, invoices
 * and the PDF that makes an invoice something a customer can keep. It owns no
 * wallet and no subscription row; the API layer binds it to migration 019 and to
 * the Step 60 subscription service.
 *
 * Five distinctions are load bearing:
 *
 *  1. **A browser redirect is not a payment.** `pending` is what a redirect
 *     means. Only a server-side verification, or a signature-checked webhook,
 *     moves a transaction to `succeeded`.
 *  2. **The amount is decided by the server.** A quote is built from the price
 *     book, the discount and the tax rows in the database. Nothing a browser
 *     sends is trusted for an amount, a workspace or a plan's privileges.
 *  3. **A reference is single-use.** `payment_transactions.provider_reference`
 *     is unique, so a replayed reference cannot buy a second period.
 *  4. **A webhook is data, not a command.** It is verified, recorded, deduped
 *     and then interpreted against an intent this server created; the owner of
 *     the purchase comes from the intent, never from the payload.
 *  5. **A refund is an operator action.** No route, scheduler or agent in this
 *     build can refund by itself, and a refund never deletes a ledger row.
 */

import type { BillingInterval } from './pricing.js';

export const PAYMENT_PROVIDERS = ['paystack', 'flutterwave', 'monnify'] as const;
export type PaymentProviderId = (typeof PAYMENT_PROVIDERS)[number];

export function isPaymentProvider(value: unknown): value is PaymentProviderId {
  return typeof value === 'string' && (PAYMENT_PROVIDERS as readonly string[]).includes(value);
}

/** A provider runs in exactly one mode at a time, chosen by the operator. */
export const PAYMENT_MODES = ['test', 'live'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/**
 * What a provider's API can actually do. Not every provider can charge a stored
 * authorization, so this is declared per adapter instead of assumed - an
 * automatic renewal on a provider without `recurring` falls back to a manual
 * renewal request rather than silently charging or silently lapsing.
 */
export interface ProviderCapabilities {
  /** Can charge a customer again from a stored authorization (no card data here). */
  readonly recurring: boolean;
  /** Collects the payment on its own hosted page. All three shipped providers do. */
  readonly hostedCheckout: boolean;
  readonly refunds: boolean;
  readonly partialRefunds: boolean;
  readonly webhooks: boolean;
  /** Currencies the operator may configure for this provider. */
  readonly currencies: readonly string[];
  /** The unit this provider's API expects for a transaction amount. */
  readonly amountUnit: 'minor' | 'major';
  /** How an inbound webhook's signature is proved. */
  readonly signature: 'hmac-sha512-body' | 'shared-secret-header';
}

/** The stored configuration of one provider. Never holds a secret. */
export interface ProviderSettings {
  readonly provider: PaymentProviderId;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly mode: PaymentMode;
  /** A publishable key is safe to send to a browser; a secret key never is. */
  readonly publicKey: string | null;
  /**
   * The **names** of the environment variables holding the secrets. The values
   * live in the deployment's secret store, so a database dump contains no key.
   */
  readonly secretRefs: {
    readonly secretKeyEnv: string;
    readonly webhookSecretEnv: string;
  };
  /** Overrides the adapter's declared currencies when an operator narrows them. */
  readonly currencies: readonly string[];
  readonly capabilities: ProviderCapabilities;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export const TRANSACTION_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'abandoned',
  'refunded',
  'partially_refunded',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/** What the purchase was for. A refund policy may treat these differently. */
export const TRANSACTION_KINDS = ['initial', 'renewal', 'upgrade', 'change', 'topup'] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export const INTENT_STATUSES = ['open', 'paid', 'expired', 'cancelled', 'failed'] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export const INVOICE_STATUSES = [
  'draft',
  'issued',
  'paid',
  'failed',
  'cancelled',
  'refunded',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const REFUND_STATUSES = ['requested', 'pending', 'succeeded', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** A checkout the server created. The amount is the server's, never the client's. */
export interface PaymentIntentRecord {
  readonly id: string;
  readonly ownerRef: string;
  /** The workspace the purchase belongs to. Null when the account has one. */
  readonly workspaceId: string | null;
  readonly planId: string;
  readonly interval: BillingInterval;
  readonly kind: TransactionKind;
  readonly provider: PaymentProviderId;
  readonly mode: PaymentMode;
  readonly currency: string;
  /** Plan price in minor units, before any reduction. */
  readonly unitAmountMinor: number;
  readonly discountMinor: number;
  readonly discountCode: string | null;
  readonly taxName: string | null;
  readonly taxRateBps: number;
  readonly taxMinor: number;
  /** The one number the provider is asked for and the one that is verified. */
  readonly totalMinor: number;
  /** This server's reference, sent to the provider as the transaction reference. */
  readonly reference: string;
  readonly status: IntentStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly paidAt: string | null;
}

export interface PaymentTransactionRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly intentId: string;
  readonly provider: PaymentProviderId;
  readonly mode: PaymentMode;
  /** The provider's own id for the charge. Unique: a reference is single-use. */
  readonly providerReference: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: TransactionStatus;
  readonly kind: TransactionKind;
  readonly planId: string;
  readonly interval: BillingInterval;
  /** Set only by a verification that passed, never by a redirect. */
  readonly verifiedAt: string | null;
  readonly failureReason: string | null;
  readonly channel: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A tokenized way to charge again. Never a card number, never a CVV. */
export interface PaymentMethodRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly provider: PaymentProviderId;
  readonly mode: PaymentMode;
  /** The provider's reusable authorization token. */
  readonly authorizationCode: string;
  readonly brand: string | null;
  readonly last4: string | null;
  readonly expMonth: string | null;
  readonly expYear: string | null;
  readonly reusable: boolean;
  readonly createdAt: string;
}

export interface InvoiceRecord {
  readonly id: string;
  readonly number: string;
  readonly ownerRef: string;
  readonly workspaceId: string | null;
  readonly planId: string;
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
  readonly customerName: string;
  readonly customerEmail: string;
  readonly customerAddress: string | null;
  readonly issuedAt: string;
  readonly dueAt: string | null;
  readonly paidAt: string | null;
  readonly transactionReference: string | null;
  readonly provider: PaymentProviderId | null;
  readonly notes: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RefundRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly transactionId: string;
  readonly provider: PaymentProviderId;
  readonly mode: PaymentMode;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: string;
  readonly status: RefundStatus;
  /** The provider's refund id, unique so the same refund cannot be recorded twice. */
  readonly providerReference: string | null;
  readonly requestedBy: string;
  readonly approvedBy: string | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A stored webhook event. The row exists before anything is acted on, so a
 * failure leaves evidence and a retry can find its own previous attempt.
 */
export interface PaymentEventRecord {
  readonly id: string;
  readonly ownerRef: string | null;
  readonly provider: PaymentProviderId;
  readonly mode: PaymentMode;
  readonly eventType: string;
  /** The provider's event id when it has one; otherwise a hash of the body. */
  readonly dedupeKey: string;
  readonly reference: string | null;
  readonly signatureValid: boolean;
  readonly status: 'received' | 'processed' | 'duplicate' | 'ignored' | 'failed' | 'rejected';
  readonly note: string | null;
  readonly attempts: number;
  readonly receivedAt: string;
  readonly processedAt: string | null;
}

export const NOTIFICATION_KINDS = [
  'payment-succeeded',
  'payment-failed',
  'subscription-activated',
  'subscription-renewed',
  'subscription-cancelled',
  'renewal-reminder',
  'refund-started',
  'refund-completed',
  'invoice-available',
  'grace-period',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** What the owner is told. `dedupeKey` is unique per owner, so nothing repeats. */
export interface BillingNotificationRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly kind: NotificationKind;
  readonly dedupeKey: string;
  readonly title: string;
  readonly message: string;
  readonly subjectId: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export const BILLING_AUDIT_ACTIONS = [
  'provider.configured',
  'provider.disabled',
  'price.created',
  'price.updated',
  'price.deactivated',
  'discount.created',
  'tax.configured',
  'intent.created',
  'payment.verified',
  'payment.failed',
  'payment.reconciled',
  'webhook.processed',
  'webhook.rejected',
  'invoice.issued',
  'invoice.paid',
  'invoice.failed',
  'invoice.cancelled',
  'refund.requested',
  'refund.approved',
  'refund.succeeded',
  'refund.failed',
  'subscription.activated',
  'subscription.renewed',
  'subscription.cancelled',
  'notification.sent',
] as const;
export type BillingAuditAction = (typeof BILLING_AUDIT_ACTIONS)[number];

/** Append-only. Kept as data so an auditor reads facts, not a log line. */
export interface BillingAuditRecord {
  readonly id: string;
  /** `platform` for configuration, `owner` for an account's own money. */
  readonly scope: 'platform' | 'owner';
  readonly ownerRef: string;
  readonly action: BillingAuditAction;
  readonly actor: string;
  readonly subject: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly at: string;
}

/** A provider's answer to "initialise this payment". */
export interface CheckoutSession {
  /** Where the customer is sent. A hosted page, so no card data touches this app. */
  readonly checkoutUrl: string;
  /** The provider's own session reference, when it returns one. */
  readonly providerReference: string | null;
  readonly mode: PaymentMode;
}

/** What a provider says about one transaction, read on the server. */
export interface VerifiedTransaction {
  readonly providerReference: string;
  readonly status: 'succeeded' | 'failed' | 'pending' | 'abandoned';
  readonly amountMinor: number;
  readonly currency: string;
  readonly channel: string | null;
  readonly paidAt: string | null;
  readonly failureReason: string | null;
  /** Present only when the provider issues a reusable token and the customer consented. */
  readonly authorization: {
    readonly code: string;
    readonly reusable: boolean;
    readonly brand: string | null;
    readonly last4: string | null;
    readonly expMonth: string | null;
    readonly expYear: string | null;
  } | null;
  readonly raw: unknown;
}

export interface RefundResult {
  readonly providerReference: string | null;
  readonly status: RefundStatus;
  readonly amountMinor: number;
  readonly raw: unknown;
}

/** A normalized inbound event. The adapter decides how to read its own payload. */
export interface NormalizedEvent {
  /** Stable per delivery. Used for dedupe, so a retry is recognised. */
  readonly eventId: string;
  readonly eventType: string;
  readonly reference: string | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly status: 'succeeded' | 'failed' | 'pending' | 'unknown';
  readonly occurredAt: string | null;
  readonly raw: unknown;
}

/** What the buyer told us at checkout. Supplied by them, used for the invoice. */
export interface BillingCustomer {
  readonly ownerRef: string;
  readonly email: string;
  readonly name: string;
  /** Two-letter country, used only to pick a configured tax row. */
  readonly country: string | null;
  readonly updatedAt: string;
}

export class PaymentError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    status = 400,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
