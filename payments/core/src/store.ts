/**
 * Where billing is kept.
 *
 * The port has four write guarantees the caller cannot provide, and each one is
 * the reason a payment bug becomes impossible rather than unlikely:
 *
 *  - **A provider reference is single-use.** `insertTransaction` refuses a
 *    reference that already exists (`DuplicateReferenceError`), so a replayed
 *    checkout cannot create a second paid transaction, and therefore cannot buy
 *    a second period.
 *  - **An event is processed once.** `insertEvent` reports whether it created the
 *    row; a duplicate delivery sees `created: false` and stops.
 *  - **An invoice number is never reused.** `nextInvoiceSequence` is an atomic
 *    counter per year. Two instances issuing at the same instant get different
 *    numbers.
 *  - **A notification is not repeated.** `insertNotification` is unique per
 *    `(owner, dedupeKey)`.
 *
 * Everything that decides *what a payment means* is a pure function over what is
 * read from here, or a service in `apps/api`.
 */

import type {
  InvoiceStatus,
  NotificationKind,
  PaymentProviderId,
  PaymentMode,
  TransactionStatus,
} from './types.js';
import type {
  BillingAuditRecord,
  BillingCustomer,
  BillingNotificationRecord,
  InvoiceRecord,
  PaymentEventRecord,
  PaymentIntentRecord,
  PaymentMethodRecord,
  PaymentTransactionRecord,
  ProviderSettings,
  RefundRecord,
} from './types.js';
import type { DiscountRecord, PriceRecord, TaxRecord } from './pricing.js';

export class DuplicateReferenceError extends Error {
  readonly code = 'REFERENCE_ALREADY_USED';
  readonly status = 409;

  constructor(reference: string) {
    super('That transaction reference has already been recorded, so it cannot be used again.');
    this.name = 'DuplicateReferenceError';
    this.details = { reference };
  }

  readonly details: Readonly<Record<string, unknown>>;
}

export interface TransactionFilter {
  readonly status?: TransactionStatus;
  readonly provider?: PaymentProviderId;
  readonly kind?: string;
  readonly limit?: number;
  readonly skip?: number;
}

export interface InvoiceFilter {
  readonly status?: InvoiceStatus;
  readonly limit?: number;
  readonly skip?: number;
}

export interface EventFilter {
  readonly provider?: PaymentProviderId;
  readonly status?: string;
  readonly limit?: number;
  readonly skip?: number;
}

export interface NotificationFilter {
  readonly unreadOnly?: boolean;
  readonly limit?: number;
}

export interface PaymentStore {
  /* Provider configuration: global, operator-only. */
  listProviders(): Promise<readonly ProviderSettings[]>;
  readProvider(provider: PaymentProviderId, mode: PaymentMode): Promise<ProviderSettings | null>;
  saveProvider(settings: ProviderSettings): Promise<ProviderSettings>;

  /* The price book. */
  listPrices(): Promise<readonly PriceRecord[]>;
  readPrice(id: string): Promise<PriceRecord | null>;
  savePrice(price: PriceRecord): Promise<PriceRecord>;

  /* Discounts and taxes. */
  listDiscounts(): Promise<readonly DiscountRecord[]>;
  readDiscount(code: string): Promise<DiscountRecord | null>;
  saveDiscount(discount: DiscountRecord): Promise<DiscountRecord>;
  /** Counts a redemption, refusing past the configured cap. */
  redeemDiscount(code: string): Promise<{ readonly redeemed: number }>;

  listTaxes(): Promise<readonly TaxRecord[]>;
  saveTax(tax: TaxRecord): Promise<TaxRecord>;

  /* The buyer's billing profile. */
  readCustomer(ownerRef: string): Promise<BillingCustomer | null>;
  saveCustomer(customer: BillingCustomer): Promise<BillingCustomer>;

  /* Checkout intents. */
  insertIntent(intent: PaymentIntentRecord): Promise<PaymentIntentRecord>;
  readIntent(id: string): Promise<PaymentIntentRecord | null>;
  findIntentByReference(reference: string): Promise<PaymentIntentRecord | null>;
  updateIntent(intent: PaymentIntentRecord): Promise<PaymentIntentRecord>;
  listIntents(ownerRef: string, limit?: number): Promise<readonly PaymentIntentRecord[]>;

  /* Transactions. */
  insertTransaction(transaction: PaymentTransactionRecord): Promise<PaymentTransactionRecord>;
  readTransaction(id: string): Promise<PaymentTransactionRecord | null>;
  findTransactionByReference(reference: string): Promise<PaymentTransactionRecord | null>;
  updateTransaction(transaction: PaymentTransactionRecord): Promise<PaymentTransactionRecord>;
  listTransactions(
    ownerRef: string,
    filter?: TransactionFilter,
  ): Promise<readonly PaymentTransactionRecord[]>;
  listAllTransactions(filter?: TransactionFilter): Promise<readonly PaymentTransactionRecord[]>;

  /* Tokenized payment methods. Never card data. */
  savePaymentMethod(method: PaymentMethodRecord): Promise<PaymentMethodRecord>;
  readPaymentMethod(ownerRef: string): Promise<PaymentMethodRecord | null>;
  clearPaymentMethod(ownerRef: string): Promise<void>;

  /* Invoices. */
  nextInvoiceSequence(year: number): Promise<number>;
  insertInvoice(invoice: InvoiceRecord): Promise<InvoiceRecord>;
  readInvoice(id: string): Promise<InvoiceRecord | null>;
  findInvoiceByNumber(number: string): Promise<InvoiceRecord | null>;
  updateInvoice(invoice: InvoiceRecord): Promise<InvoiceRecord>;
  listInvoices(ownerRef: string, filter?: InvoiceFilter): Promise<readonly InvoiceRecord[]>;

  /* Refunds. */
  insertRefund(refund: RefundRecord): Promise<RefundRecord>;
  readRefund(id: string): Promise<RefundRecord | null>;
  updateRefund(refund: RefundRecord): Promise<RefundRecord>;
  listRefunds(ownerRef: string, limit?: number): Promise<readonly RefundRecord[]>;
  listRefundsForTransaction(transactionId: string): Promise<readonly RefundRecord[]>;
  findRefundByProviderReference(reference: string): Promise<RefundRecord | null>;

  /* Webhook events. */
  insertEvent(event: PaymentEventRecord): Promise<{ readonly created: boolean }>;
  updateEvent(event: PaymentEventRecord): Promise<PaymentEventRecord>;
  listEvents(filter?: EventFilter): Promise<readonly PaymentEventRecord[]>;

  /* Notifications and audit. */
  insertNotification(
    notification: BillingNotificationRecord,
  ): Promise<{ readonly created: boolean }>;
  listNotifications(
    ownerRef: string,
    filter?: NotificationFilter,
  ): Promise<readonly BillingNotificationRecord[]>;
  markNotificationsRead(ownerRef: string, ids?: readonly string[]): Promise<number>;

  appendAudit(record: BillingAuditRecord): Promise<void>;
  listAudit(ownerRef: string, limit?: number): Promise<readonly BillingAuditRecord[]>;
  listPlatformAudit(limit?: number): Promise<readonly BillingAuditRecord[]>;

  /* Reconciliation helpers. */
  /** Transactions the operator asked to see, newest first. */
  listTransactionsByMode?(mode: PaymentMode): Promise<readonly PaymentTransactionRecord[]>;
  readonly durable: boolean;
}

export type { NotificationKind };
