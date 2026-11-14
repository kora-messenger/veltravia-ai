/**
 * @veltravia/payments-core - Step 61.
 *
 * The shape of a payment system and the rules that need no database: integer
 * money, a configurable price book, provider adapters for Paystack, Flutterwave
 * and Monnify, webhook verification and replay rules, invoices, receipts and a
 * PDF writer.
 *
 * It owns no wallet, no ledger and no subscription row. Step 60's subscription
 * service stays the only place that decides what a plan means, and Steps 52-59
 * keep being the only place a credit or a balance exists.
 *
 * The moving parts:
 *
 *  - `money`    - minor units, conversion, formatting, rate arithmetic.
 *  - `pricing`  - the price book, discounts, taxes and the one quote function.
 *  - `provider` - the adapter seam and the injected transport.
 *  - `adapters` - Paystack, Flutterwave and Monnify, each declaring its gaps.
 *  - `webhooks` - signature-first, recorded, deduped, replay-bounded.
 *  - `invoices` - numbering, the invoice body, and printable documents.
 *  - `pdf`      - a small, deterministic PDF writer.
 *  - `policies` - refund, grace, retry and top-up defaults.
 *  - `store`    - the port, with four write guarantees.
 *  - `memory`   - the in-memory implementation of that port.
 */

export * from './money.js';
export * from './types.js';
export * from './pricing.js';
export * from './provider.js';
export * from './adapters.js';
export * from './webhooks.js';
export * from './invoices.js';
export * from './pdf.js';
export * from './policies.js';
export * from './store.js';
export * from './memory.js';
