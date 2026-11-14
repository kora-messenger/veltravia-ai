/**
 * Invoices and receipts.
 *
 * An invoice is a record of what was charged, not a view of the current price
 * list. Every amount is copied at issue time, so editing a plan's price next
 * month cannot rewrite last month's invoice - which is the whole reason a
 * business keeps them.
 *
 * Two things this file refuses to do:
 *
 *  - **It invents no tax.** The tax row comes from configuration; when none is
 *    configured, the invoice states that the total is tax exclusive and carries
 *    no rate. It never prints a rate nobody set, and nothing here claims tax
 *    compliance for a jurisdiction.
 *  - **It cannot number twice.** The number is `INV-<year>-<sequence>`, and the
 *    sequence comes from a store counter that is incremented atomically. The
 *    formatting lives here so an invoice number is reproducible from its parts;
 *    the uniqueness is the store's job and is tested against Postgres.
 */

import { formatAmount } from './money.js';
import type { BillingInterval, PurchaseQuote } from './pricing.js';
import type { InvoiceRecord, InvoiceStatus, PaymentProviderId } from './types.js';

export type { BillingInterval };

export const INVOICE_NUMBER_PREFIX = 'INV';

export function formatInvoiceNumber(year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new Error('An invoice year is four digits.');
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error('An invoice sequence starts at 1.');
  }
  return `${INVOICE_NUMBER_PREFIX}-${year}-${String(sequence).padStart(6, '0')}`;
}

export function parseInvoiceNumber(
  value: string,
): { readonly year: number; readonly sequence: number } | null {
  const match = /^INV-(\d{4})-(\d{6,})$/.exec(value.trim().toUpperCase());
  if (match === null) return null;
  const year = Number(match[1]);
  const sequence = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(sequence)) return null;
  return { year, sequence };
}

/** The year an invoice is numbered within. Its issue date decides. */
export function invoiceYear(issuedAt: string): number {
  const parsed = Date.parse(issuedAt);
  if (Number.isNaN(parsed)) throw new Error('An invoice needs a real issue date.');
  return new Date(parsed).getUTCFullYear();
}

const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ['issued', 'cancelled'],
  issued: ['paid', 'failed', 'cancelled'],
  paid: ['refunded'],
  failed: ['issued', 'cancelled'],
  cancelled: [],
  refunded: [],
};

export function canTransitionInvoice(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS[from].includes(to);
}

export interface InvoiceCustomer {
  readonly name: string;
  readonly email: string;
  readonly address: string | null;
}

export interface DraftInvoiceInput {
  readonly quote: PurchaseQuote;
  readonly planName: string;
  readonly interval: BillingInterval;
  readonly customer: InvoiceCustomer;
  readonly issuedAt: string;
  /** Net terms in days. `0` means due on issue, which is what a card payment is. */
  readonly dueInDays?: number;
  readonly workspaceId?: string | null;
  readonly provider?: PaymentProviderId | null;
  readonly transactionReference?: string | null;
  readonly notes?: readonly string[];
}

/** The invoice body, before it is given an id and a number by the store. */
export interface InvoiceDraft {
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
  readonly customerName: string;
  readonly customerEmail: string;
  readonly customerAddress: string | null;
  readonly issuedAt: string;
  readonly dueAt: string | null;
  readonly workspaceId: string | null;
  readonly provider: PaymentProviderId | null;
  readonly transactionReference: string | null;
  readonly notes: readonly string[];
}

export function buildInvoiceDraft(input: DraftInvoiceInput): InvoiceDraft {
  const { quote } = input;
  const dueInDays = input.dueInDays ?? 0;
  const dueAt =
    dueInDays <= 0
      ? input.issuedAt
      : new Date(Date.parse(input.issuedAt) + dueInDays * 86_400_000).toISOString();
  const notes = [...(input.notes ?? [])];
  if (quote.taxName === null) {
    notes.push('No tax was configured for this purchase, so no tax is included in the total.');
  }
  return {
    planId: quote.planId,
    planName: input.planName,
    interval: input.interval,
    currency: quote.currency,
    unitAmountMinor: quote.unitAmountMinor,
    discountMinor: quote.discountMinor,
    subtotalMinor: quote.subtotalMinor,
    taxName: quote.taxName,
    taxRateBps: quote.taxRateBps,
    taxMinor: quote.taxMinor,
    totalMinor: quote.totalMinor,
    customerName: input.customer.name,
    customerEmail: input.customer.email,
    customerAddress: input.customer.address,
    issuedAt: input.issuedAt,
    dueAt,
    workspaceId: input.workspaceId ?? null,
    provider: input.provider ?? null,
    transactionReference: input.transactionReference ?? null,
    notes,
  };
}

/**
 * A printable document, provider-neutral. The PDF renderer consumes this; so
 * does an on-screen preview, so what a customer downloads is what they saw.
 */
export interface DocumentLine {
  readonly label: string;
  readonly detail: string;
  readonly amount: string | null;
}

export interface DocumentTotal {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
}

export interface PrintableDocument {
  readonly kind: 'invoice' | 'receipt';
  readonly title: string;
  readonly number: string;
  readonly statusLine: string;
  readonly business: { readonly name: string; readonly lines: readonly string[] };
  readonly customer: { readonly name: string; readonly lines: readonly string[] };
  readonly meta: readonly { readonly label: string; readonly value: string }[];
  readonly lines: readonly DocumentLine[];
  readonly totals: readonly DocumentTotal[];
  readonly footer: readonly string[];
}

export interface BusinessIdentity {
  readonly name: string;
  readonly lines?: readonly string[];
}

const INTERVAL_WORDS: Readonly<Record<BillingInterval, string>> = {
  monthly: 'Monthly',
  yearly: 'Yearly',
};

function isoDate(value: string | null): string {
  if (value === null) return 'Not paid';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return 'Not paid';
  return new Date(parsed).toISOString().slice(0, 10);
}

export function invoiceDocument(
  invoice: InvoiceRecord,
  business: BusinessIdentity = { name: 'Veltravia AI' },
): PrintableDocument {
  const currency = invoice.currency;
  const totals: DocumentTotal[] = [
    {
      label: `${invoice.planName} (${INTERVAL_WORDS[invoice.interval]})`,
      value: formatAmount(invoice.unitAmountMinor, currency),
    },
  ];
  if (invoice.discountMinor > 0) {
    totals.push({ label: 'Discount', value: `-${formatAmount(invoice.discountMinor, currency)}` });
  }
  totals.push({ label: 'Subtotal', value: formatAmount(invoice.subtotalMinor, currency) });
  if (invoice.taxMinor > 0 && invoice.taxName !== null) {
    totals.push({
      label: `${invoice.taxName} (${(invoice.taxRateBps / 100).toFixed(2)}%)`,
      value: formatAmount(invoice.taxMinor, currency),
    });
  }
  totals.push({
    label: 'Total',
    value: formatAmount(invoice.totalMinor, currency),
    emphasis: true,
  });

  return {
    kind: 'invoice',
    title: 'Invoice',
    number: invoice.number,
    statusLine: invoiceStatusLine(invoice.status),
    business: { name: business.name, lines: business.lines ?? [] },
    customer: {
      name: invoice.customerName,
      lines: [
        invoice.customerEmail,
        ...(invoice.customerAddress === null ? [] : [invoice.customerAddress]),
      ].filter((line) => line.trim() !== ''),
    },
    meta: [
      { label: 'Issued', value: isoDate(invoice.issuedAt) },
      { label: 'Due', value: isoDate(invoice.dueAt) },
      { label: 'Paid', value: isoDate(invoice.paidAt) },
      { label: 'Provider', value: invoice.provider ?? 'Not paid through a provider' },
      { label: 'Transaction', value: invoice.transactionReference ?? 'None' },
      { label: 'Currency', value: currency },
    ],
    lines: [
      {
        label: invoice.planName,
        detail: `${INTERVAL_WORDS[invoice.interval]} subscription${
          invoice.workspaceId === null ? '' : ` for ${invoice.workspaceId}`
        }`,
        amount: formatAmount(invoice.unitAmountMinor, currency),
      },
    ],
    totals,
    footer: [
      ...invoice.notes,
      'This document was produced by Veltravia AI from the record of a verified payment.',
    ],
  };
}

export function receiptDocument(
  invoice: InvoiceRecord,
  business: BusinessIdentity = { name: 'Veltravia AI' },
): PrintableDocument {
  const base = invoiceDocument(invoice, business);
  return {
    ...base,
    kind: 'receipt',
    title: 'Receipt',
    statusLine:
      invoice.status === 'paid'
        ? 'Paid in full'
        : invoice.status === 'refunded'
          ? 'Refunded'
          : invoiceStatusLine(invoice.status),
    footer: ['A receipt confirms a payment that was verified with the provider.', ...base.footer],
  };
}

export function invoiceStatusLine(status: InvoiceStatus): string {
  switch (status) {
    case 'draft':
      return 'Draft - not issued';
    case 'issued':
      return 'Issued - awaiting payment';
    case 'paid':
      return 'Paid';
    case 'failed':
      return 'Payment failed';
    case 'cancelled':
      return 'Cancelled';
    case 'refunded':
      return 'Refunded';
  }
}
