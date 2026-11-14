/**
 * The in-memory store.
 *
 * Used by tests, by a laptop with no database, and by the API when no Postgres is
 * configured. It implements the same guarantees as the Postgres store - unique
 * references, one event per dedupe key, an atomic invoice counter - because a
 * guarantee that only holds in one implementation is not a guarantee the service
 * can rely on.
 */

import type { PriceRecord, DiscountRecord, TaxRecord } from './pricing.js';
import {
  DuplicateReferenceError,
  type EventFilter,
  type InvoiceFilter,
  type NotificationFilter,
  type PaymentStore,
  type TransactionFilter,
} from './store.js';
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryPaymentStore implements PaymentStore {
  readonly durable = false;

  private providers = new Map<string, ProviderSettings>();
  private prices = new Map<string, PriceRecord>();
  private discounts = new Map<string, DiscountRecord>();
  private taxes = new Map<string, TaxRecord>();
  private customers = new Map<string, BillingCustomer>();
  private intents = new Map<string, PaymentIntentRecord>();
  private transactions = new Map<string, PaymentTransactionRecord>();
  private references = new Map<string, string>();
  private methods = new Map<string, PaymentMethodRecord>();
  private invoices = new Map<string, InvoiceRecord>();
  private invoiceNumbers = new Map<string, string>();
  private sequences = new Map<number, number>();
  private refunds = new Map<string, RefundRecord>();
  private refundReferences = new Map<string, string>();
  private events = new Map<string, PaymentEventRecord>();
  private eventKeys = new Set<string>();
  private notifications = new Map<string, BillingNotificationRecord>();
  private notificationKeys = new Set<string>();
  private audit: BillingAuditRecord[] = [];

  private static newer = <T extends { createdAt: string }>(
    rows: readonly T[],
    limit?: number,
  ): T[] =>
    [...rows]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit ?? 200);

  async listProviders(): Promise<readonly ProviderSettings[]> {
    return [...this.providers.values()].map(clone);
  }

  async readProvider(provider: ProviderSettings['provider'], mode: ProviderSettings['mode']) {
    const found = this.providers.get(`${provider}:${mode}`);
    return found === undefined ? null : clone(found);
  }

  async saveProvider(settings: ProviderSettings): Promise<ProviderSettings> {
    this.providers.set(`${settings.provider}:${settings.mode}`, clone(settings));
    return clone(settings);
  }

  async listPrices(): Promise<readonly PriceRecord[]> {
    return [...this.prices.values()].map(clone);
  }

  async readPrice(id: string): Promise<PriceRecord | null> {
    const found = this.prices.get(id);
    return found === undefined ? null : clone(found);
  }

  async savePrice(price: PriceRecord): Promise<PriceRecord> {
    this.prices.set(price.id, clone(price));
    return clone(price);
  }

  async listDiscounts(): Promise<readonly DiscountRecord[]> {
    return [...this.discounts.values()].map(clone);
  }

  async readDiscount(code: string): Promise<DiscountRecord | null> {
    const found = this.discounts.get(code.trim().toUpperCase());
    return found === undefined ? null : clone(found);
  }

  async saveDiscount(discount: DiscountRecord): Promise<DiscountRecord> {
    this.discounts.set(discount.code, clone(discount));
    return clone(discount);
  }

  async redeemDiscount(code: string): Promise<{ redeemed: number }> {
    const key = code.trim().toUpperCase();
    const existing = this.discounts.get(key);
    if (existing === undefined) throw new Error('No such discount code.');
    if (existing.maxRedemptions !== null && existing.redemptions >= existing.maxRedemptions) {
      throw new Error('That discount code has been used up.');
    }
    const next = { ...existing, redemptions: existing.redemptions + 1 };
    this.discounts.set(key, next);
    return { redeemed: next.redemptions };
  }

  async listTaxes(): Promise<readonly TaxRecord[]> {
    return [...this.taxes.values()].map(clone);
  }

  async saveTax(tax: TaxRecord): Promise<TaxRecord> {
    this.taxes.set(tax.id, clone(tax));
    return clone(tax);
  }

  async readCustomer(ownerRef: string): Promise<BillingCustomer | null> {
    const found = this.customers.get(ownerRef);
    return found === undefined ? null : clone(found);
  }

  async saveCustomer(customer: BillingCustomer): Promise<BillingCustomer> {
    this.customers.set(customer.ownerRef, clone(customer));
    return clone(customer);
  }

  async insertIntent(intent: PaymentIntentRecord): Promise<PaymentIntentRecord> {
    this.intents.set(intent.id, clone(intent));
    return clone(intent);
  }

  async readIntent(id: string): Promise<PaymentIntentRecord | null> {
    const found = this.intents.get(id);
    return found === undefined ? null : clone(found);
  }

  async findIntentByReference(reference: string): Promise<PaymentIntentRecord | null> {
    for (const intent of this.intents.values()) {
      if (intent.reference === reference) return clone(intent);
    }
    return null;
  }

  async updateIntent(intent: PaymentIntentRecord): Promise<PaymentIntentRecord> {
    this.intents.set(intent.id, clone(intent));
    return clone(intent);
  }

  async listIntents(ownerRef: string, limit?: number): Promise<readonly PaymentIntentRecord[]> {
    const mine = [...this.intents.values()].filter((intent) => intent.ownerRef === ownerRef);
    return InMemoryPaymentStore.newer(mine, limit).map(clone);
  }

  async insertTransaction(
    transaction: PaymentTransactionRecord,
  ): Promise<PaymentTransactionRecord> {
    if (this.references.has(transaction.providerReference)) {
      throw new DuplicateReferenceError(transaction.providerReference);
    }
    this.transactions.set(transaction.id, clone(transaction));
    this.references.set(transaction.providerReference, transaction.id);
    return clone(transaction);
  }

  async readTransaction(id: string): Promise<PaymentTransactionRecord | null> {
    const found = this.transactions.get(id);
    return found === undefined ? null : clone(found);
  }

  async findTransactionByReference(reference: string): Promise<PaymentTransactionRecord | null> {
    const id = this.references.get(reference);
    if (id === undefined) return null;
    return this.readTransaction(id);
  }

  async updateTransaction(
    transaction: PaymentTransactionRecord,
  ): Promise<PaymentTransactionRecord> {
    this.transactions.set(transaction.id, clone(transaction));
    this.references.set(transaction.providerReference, transaction.id);
    return clone(transaction);
  }

  async listTransactions(
    ownerRef: string,
    filter?: TransactionFilter,
  ): Promise<readonly PaymentTransactionRecord[]> {
    return this.filterTransactions(filter)
      .filter((transaction) => transaction.ownerRef === ownerRef)
      .map(clone);
  }

  async listAllTransactions(
    filter?: TransactionFilter,
  ): Promise<readonly PaymentTransactionRecord[]> {
    return this.filterTransactions(filter).map(clone);
  }

  private filterTransactions(filter?: TransactionFilter): PaymentTransactionRecord[] {
    let rows = [...this.transactions.values()];
    if (filter?.status !== undefined) rows = rows.filter((row) => row.status === filter.status);
    if (filter?.provider !== undefined)
      rows = rows.filter((row) => row.provider === filter.provider);
    if (filter?.kind !== undefined) rows = rows.filter((row) => row.kind === filter.kind);
    const sorted = InMemoryPaymentStore.newer(rows);
    const skip = filter?.skip ?? 0;
    return sorted.slice(skip, skip + (filter?.limit ?? 200));
  }

  async savePaymentMethod(method: PaymentMethodRecord): Promise<PaymentMethodRecord> {
    this.methods.set(method.ownerRef, clone(method));
    return clone(method);
  }

  async readPaymentMethod(ownerRef: string): Promise<PaymentMethodRecord | null> {
    const found = this.methods.get(ownerRef);
    return found === undefined ? null : clone(found);
  }

  async clearPaymentMethod(ownerRef: string): Promise<void> {
    this.methods.delete(ownerRef);
  }

  async nextInvoiceSequence(year: number): Promise<number> {
    const next = (this.sequences.get(year) ?? 0) + 1;
    this.sequences.set(year, next);
    return next;
  }

  async insertInvoice(invoice: InvoiceRecord): Promise<InvoiceRecord> {
    if (this.invoiceNumbers.has(invoice.number)) {
      throw new Error('That invoice number already exists.');
    }
    this.invoices.set(invoice.id, clone(invoice));
    this.invoiceNumbers.set(invoice.number, invoice.id);
    return clone(invoice);
  }

  async readInvoice(id: string): Promise<InvoiceRecord | null> {
    const found = this.invoices.get(id);
    return found === undefined ? null : clone(found);
  }

  async findInvoiceByNumber(number: string): Promise<InvoiceRecord | null> {
    const id = this.invoiceNumbers.get(number);
    if (id === undefined) return null;
    return this.readInvoice(id);
  }

  async updateInvoice(invoice: InvoiceRecord): Promise<InvoiceRecord> {
    this.invoices.set(invoice.id, clone(invoice));
    this.invoiceNumbers.set(invoice.number, invoice.id);
    return clone(invoice);
  }

  async listInvoices(ownerRef: string, filter?: InvoiceFilter): Promise<readonly InvoiceRecord[]> {
    let rows = [...this.invoices.values()].filter((invoice) => invoice.ownerRef === ownerRef);
    if (filter?.status !== undefined) rows = rows.filter((row) => row.status === filter.status);
    const sorted = InMemoryPaymentStore.newer(rows);
    const skip = filter?.skip ?? 0;
    return sorted.slice(skip, skip + (filter?.limit ?? 200)).map(clone);
  }

  async insertRefund(refund: RefundRecord): Promise<RefundRecord> {
    if (refund.providerReference !== null && this.refundReferences.has(refund.providerReference)) {
      throw new DuplicateReferenceError(refund.providerReference);
    }
    this.refunds.set(refund.id, clone(refund));
    if (refund.providerReference !== null) {
      this.refundReferences.set(refund.providerReference, refund.id);
    }
    return clone(refund);
  }

  async readRefund(id: string): Promise<RefundRecord | null> {
    const found = this.refunds.get(id);
    return found === undefined ? null : clone(found);
  }

  async updateRefund(refund: RefundRecord): Promise<RefundRecord> {
    this.refunds.set(refund.id, clone(refund));
    if (refund.providerReference !== null) {
      this.refundReferences.set(refund.providerReference, refund.id);
    }
    return clone(refund);
  }

  async listRefunds(ownerRef: string, limit?: number): Promise<readonly RefundRecord[]> {
    const mine = [...this.refunds.values()].filter((refund) => refund.ownerRef === ownerRef);
    return InMemoryPaymentStore.newer(mine, limit).map(clone);
  }

  async listRefundsForTransaction(transactionId: string): Promise<readonly RefundRecord[]> {
    return [...this.refunds.values()]
      .filter((refund) => refund.transactionId === transactionId)
      .map(clone);
  }

  async findRefundByProviderReference(reference: string): Promise<RefundRecord | null> {
    const id = this.refundReferences.get(reference);
    if (id === undefined) return null;
    return this.readRefund(id);
  }

  async insertEvent(event: PaymentEventRecord): Promise<{ created: boolean }> {
    const key = `${event.ownerRef ?? '*'}:${event.dedupeKey}`;
    if (this.eventKeys.has(key)) return { created: false };
    this.eventKeys.add(key);
    this.events.set(event.id, clone(event));
    return { created: true };
  }

  async updateEvent(event: PaymentEventRecord): Promise<PaymentEventRecord> {
    this.events.set(event.id, clone(event));
    return clone(event);
  }

  async listEvents(filter?: EventFilter): Promise<readonly PaymentEventRecord[]> {
    let rows = [...this.events.values()];
    if (filter?.provider !== undefined)
      rows = rows.filter((row) => row.provider === filter.provider);
    if (filter?.status !== undefined) rows = rows.filter((row) => row.status === filter.status);
    const sorted = [...rows].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    const skip = filter?.skip ?? 0;
    return sorted.slice(skip, skip + (filter?.limit ?? 200)).map(clone);
  }

  async insertNotification(notification: BillingNotificationRecord): Promise<{ created: boolean }> {
    const key = `${notification.ownerRef}:${notification.dedupeKey}`;
    if (this.notificationKeys.has(key)) return { created: false };
    this.notificationKeys.add(key);
    this.notifications.set(notification.id, clone(notification));
    return { created: true };
  }

  async listNotifications(
    ownerRef: string,
    filter?: NotificationFilter,
  ): Promise<readonly BillingNotificationRecord[]> {
    let rows = [...this.notifications.values()].filter((row) => row.ownerRef === ownerRef);
    if (filter?.unreadOnly === true) rows = rows.filter((row) => row.readAt === null);
    const sorted = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return sorted.slice(0, filter?.limit ?? 50).map(clone);
  }

  async markNotificationsRead(ownerRef: string, ids?: readonly string[]): Promise<number> {
    const at = new Date().toISOString();
    let count = 0;
    for (const [id, row] of this.notifications) {
      if (row.ownerRef !== ownerRef) continue;
      if (ids !== undefined && !ids.includes(id)) continue;
      if (row.readAt !== null) continue;
      this.notifications.set(id, { ...row, readAt: at });
      count += 1;
    }
    return count;
  }

  async appendAudit(record: BillingAuditRecord): Promise<void> {
    this.audit.push(clone(record));
  }

  async listAudit(ownerRef: string, limit?: number): Promise<readonly BillingAuditRecord[]> {
    const mine = this.audit.filter((row) => row.ownerRef === ownerRef);
    return [...mine]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, limit ?? 200)
      .map(clone);
  }

  async listPlatformAudit(limit?: number): Promise<readonly BillingAuditRecord[]> {
    const platform = this.audit.filter((row) => row.scope === 'platform');
    return [...platform]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, limit ?? 200)
      .map(clone);
  }
}
