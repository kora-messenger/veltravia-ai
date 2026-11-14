/**
 * Payments, invoices, refunds, events and notifications in PostgreSQL (Step 61).
 *
 * Two scopes again, and for the same reason as Step 60:
 *
 *  - **Configuration is global** - providers, prices, discounts, taxes - and
 *    carries no owner. Only the operator surface writes it, and the operator
 *    token is checked at the route.
 *  - **Money is owner data.** A charge, an invoice, a refund and a notification
 *    belong to the account that paid, and every owner write asserts that the
 *    owner in scope is the owner being written.
 *
 * Three guarantees live in SQL rather than in the caller:
 *
 *  - **A provider reference is single-use.** The unique constraint raises, and it
 *    is translated into `DuplicateReferenceError` so the service can answer 409
 *    without reading a database error.
 *  - **An event is recorded once.** `insertEvent` inserts `on conflict do
 *    nothing` and reports whether it created the row.
 *  - **An invoice number is atomic.** `nextInvoiceSequence` increments a per-year
 *    counter in one statement, so two instances issuing together get different
 *    numbers.
 */

import type {
  DiscountRecord,
  EventFilter,
  InvoiceFilter,
  NotificationFilter,
  PaymentStore,
  PriceRecord,
  TaxRecord,
  TransactionFilter,
} from '@veltravia/payments-core';
import { DuplicateReferenceError } from '@veltravia/payments-core';
import type {
  BillingAuditRecord,
  BillingCustomer,
  BillingNotificationRecord,
  InvoiceRecord,
  InvoiceStatus,
  NotificationKind,
  PaymentEventRecord,
  PaymentIntentRecord,
  PaymentMethodRecord,
  PaymentProviderId,
  PaymentTransactionRecord,
  ProviderCapabilities,
  ProviderSettings,
  RefundRecord,
  TransactionStatus,
} from '@veltravia/payments-core';

import { assertOwnerMatch } from '../owner-scope.js';
import { DatabaseError } from '../errors.js';
import type { Database } from '../pool.js';

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof DatabaseError && error.sqlState === UNIQUE_VIOLATION;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : value;

interface ProviderRow {
  provider: PaymentProviderId;
  mode: 'test' | 'live';
  display_name: string;
  enabled: boolean;
  public_key: string | null;
  secret_key_env: string;
  webhook_secret_env: string;
  currencies: string[] | null;
  capabilities: ProviderCapabilities | null;
  version: number;
  updated_at: Date;
  updated_by: string;
}

interface PriceRow {
  id: string;
  plan_id: string;
  interval: 'monthly' | 'yearly';
  currency: string;
  amount_minor: string | number;
  active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
  updated_by: string;
}

interface DiscountRow {
  code: string;
  description: string;
  percent_off: number;
  amount_off_minor: string | number | null;
  currency: string | null;
  active: boolean;
  starts_at: Date | null;
  expires_at: Date | null;
  max_redemptions: number | null;
  redemptions: number;
  created_at: Date;
  updated_at: Date;
  updated_by: string;
}

interface TaxRow {
  id: string;
  name: string;
  country: string | null;
  rate_bps: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
  updated_by: string;
}

interface IntentRow {
  id: string;
  owner_ref: string;
  workspace_id: string | null;
  plan_id: string;
  interval: 'monthly' | 'yearly';
  kind: PaymentIntentRecord['kind'];
  provider: PaymentProviderId;
  mode: 'test' | 'live';
  currency: string;
  unit_amount_minor: string | number;
  discount_minor: string | number;
  discount_code: string | null;
  tax_name: string | null;
  tax_rate_bps: number;
  tax_minor: string | number;
  total_minor: string | number;
  reference: string;
  status: PaymentIntentRecord['status'];
  created_at: Date;
  expires_at: Date;
  paid_at: Date | null;
}

interface TransactionRow {
  id: string;
  owner_ref: string;
  intent_id: string;
  provider: PaymentProviderId;
  mode: 'test' | 'live';
  provider_reference: string;
  amount_minor: string | number;
  currency: string;
  status: TransactionStatus;
  kind: PaymentTransactionRecord['kind'];
  plan_id: string;
  interval: 'monthly' | 'yearly';
  verified_at: Date | null;
  failure_reason: string | null;
  channel: string | null;
  created_at: Date;
  updated_at: Date;
}

interface InvoiceRow {
  id: string;
  number: string;
  owner_ref: string;
  workspace_id: string | null;
  plan_id: string;
  plan_name: string;
  interval: 'monthly' | 'yearly';
  currency: string;
  unit_amount_minor: string | number;
  discount_minor: string | number;
  subtotal_minor: string | number;
  tax_name: string | null;
  tax_rate_bps: number;
  tax_minor: string | number;
  total_minor: string | number;
  status: InvoiceStatus;
  customer_name: string;
  customer_email: string;
  customer_address: string | null;
  issued_at: Date;
  due_at: Date | null;
  paid_at: Date | null;
  transaction_reference: string | null;
  provider: PaymentProviderId | null;
  notes: string[] | null;
  created_at: Date;
  updated_at: Date;
}

interface RefundRow {
  id: string;
  owner_ref: string;
  transaction_id: string;
  provider: PaymentProviderId;
  mode: 'test' | 'live';
  amount_minor: string | number;
  currency: string;
  reason: string;
  status: RefundRecord['status'];
  provider_reference: string | null;
  requested_by: string;
  approved_by: string | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

interface EventRow {
  id: string;
  owner_ref: string | null;
  provider: PaymentProviderId;
  mode: 'test' | 'live';
  event_type: string;
  dedupe_key: string;
  reference: string | null;
  signature_valid: boolean;
  status: PaymentEventRecord['status'];
  note: string | null;
  attempts: number;
  received_at: Date;
  processed_at: Date | null;
}

interface NotificationRow {
  id: string;
  owner_ref: string;
  kind: NotificationKind;
  dedupe_key: string;
  title: string;
  message: string;
  subject_id: string | null;
  created_at: Date;
  read_at: Date | null;
}

interface AuditRow {
  id: string;
  scope: 'platform' | 'owner';
  owner_ref: string;
  action: string;
  actor: string;
  subject: string;
  detail: Record<string, unknown> | null;
  at: Date;
}

const num = (value: string | number | null): number =>
  value === null ? 0 : typeof value === 'number' ? value : Number(value);

const toProvider = (row: ProviderRow): ProviderSettings => ({
  provider: row.provider,
  displayName: row.display_name,
  enabled: row.enabled,
  mode: row.mode,
  publicKey: row.public_key,
  secretRefs: { secretKeyEnv: row.secret_key_env, webhookSecretEnv: row.webhook_secret_env },
  currencies: row.currencies ?? [],
  capabilities: row.capabilities ?? {
    recurring: false,
    hostedCheckout: false,
    refunds: false,
    partialRefunds: false,
    webhooks: false,
    currencies: [],
    amountUnit: 'minor',
    signature: 'hmac-sha512-body',
  },
  version: row.version,
  updatedAt: row.updated_at.toISOString(),
  updatedBy: row.updated_by,
});

const toPrice = (row: PriceRow): PriceRecord => ({
  id: row.id,
  planId: row.plan_id,
  interval: row.interval,
  currency: row.currency.trim(),
  amountMinor: num(row.amount_minor),
  active: row.active,
  version: row.version,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  updatedBy: row.updated_by,
});

const toDiscount = (row: DiscountRow): DiscountRecord => ({
  code: row.code,
  description: row.description,
  percentOff: row.percent_off,
  amountOffMinor: row.amount_off_minor === null ? null : num(row.amount_off_minor),
  currency: row.currency,
  active: row.active,
  startsAt: iso(row.starts_at),
  expiresAt: iso(row.expires_at),
  maxRedemptions: row.max_redemptions,
  redemptions: row.redemptions,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  updatedBy: row.updated_by,
});

const toTax = (row: TaxRow): TaxRecord => ({
  id: row.id,
  name: row.name,
  country: row.country,
  rateBps: row.rate_bps,
  active: row.active,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  updatedBy: row.updated_by,
});

const toIntent = (row: IntentRow): PaymentIntentRecord => ({
  id: row.id,
  ownerRef: row.owner_ref,
  workspaceId: row.workspace_id,
  planId: row.plan_id,
  interval: row.interval,
  kind: row.kind,
  provider: row.provider,
  mode: row.mode,
  currency: row.currency,
  unitAmountMinor: num(row.unit_amount_minor),
  discountMinor: num(row.discount_minor),
  discountCode: row.discount_code,
  taxName: row.tax_name,
  taxRateBps: row.tax_rate_bps,
  taxMinor: num(row.tax_minor),
  totalMinor: num(row.total_minor),
  reference: row.reference,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  paidAt: iso(row.paid_at),
});

const toTransaction = (row: TransactionRow): PaymentTransactionRecord => ({
  id: row.id,
  ownerRef: row.owner_ref,
  intentId: row.intent_id,
  provider: row.provider,
  mode: row.mode,
  providerReference: row.provider_reference,
  amountMinor: num(row.amount_minor),
  currency: row.currency,
  status: row.status,
  kind: row.kind,
  planId: row.plan_id,
  interval: row.interval,
  verifiedAt: iso(row.verified_at),
  failureReason: row.failure_reason,
  channel: row.channel,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const toInvoice = (row: InvoiceRow): InvoiceRecord => ({
  id: row.id,
  number: row.number,
  ownerRef: row.owner_ref,
  workspaceId: row.workspace_id,
  planId: row.plan_id,
  planName: row.plan_name,
  interval: row.interval,
  currency: row.currency,
  unitAmountMinor: num(row.unit_amount_minor),
  discountMinor: num(row.discount_minor),
  subtotalMinor: num(row.subtotal_minor),
  taxName: row.tax_name,
  taxRateBps: row.tax_rate_bps,
  taxMinor: num(row.tax_minor),
  totalMinor: num(row.total_minor),
  status: row.status,
  customerName: row.customer_name,
  customerEmail: row.customer_email,
  customerAddress: row.customer_address,
  issuedAt: row.issued_at.toISOString(),
  dueAt: iso(row.due_at),
  paidAt: iso(row.paid_at),
  transactionReference: row.transaction_reference,
  provider: row.provider,
  notes: row.notes ?? [],
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const toRefund = (row: RefundRow): RefundRecord => ({
  id: row.id,
  ownerRef: row.owner_ref,
  transactionId: row.transaction_id,
  provider: row.provider,
  mode: row.mode,
  amountMinor: num(row.amount_minor),
  currency: row.currency,
  reason: row.reason,
  status: row.status,
  providerReference: row.provider_reference,
  requestedBy: row.requested_by,
  approvedBy: row.approved_by,
  note: row.note,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const toEvent = (row: EventRow): PaymentEventRecord => ({
  id: row.id,
  ownerRef: row.owner_ref,
  provider: row.provider,
  mode: row.mode,
  eventType: row.event_type,
  dedupeKey: row.dedupe_key,
  reference: row.reference,
  signatureValid: row.signature_valid,
  status: row.status,
  note: row.note,
  attempts: row.attempts,
  receivedAt: row.received_at.toISOString(),
  processedAt: iso(row.processed_at),
});

const toNotification = (row: NotificationRow): BillingNotificationRecord => ({
  id: row.id,
  ownerRef: row.owner_ref,
  kind: row.kind,
  dedupeKey: row.dedupe_key,
  title: row.title,
  message: row.message,
  subjectId: row.subject_id,
  createdAt: row.created_at.toISOString(),
  readAt: iso(row.read_at),
});

const toAudit = (row: AuditRow): BillingAuditRecord => ({
  id: row.id,
  scope: row.scope,
  ownerRef: row.owner_ref,
  action: row.action as BillingAuditRecord['action'],
  actor: row.actor,
  subject: row.subject,
  detail: row.detail ?? {},
  at: row.at.toISOString(),
});

export class PostgresPaymentStore implements PaymentStore {
  readonly durable = true;

  constructor(private readonly database: Database) {}

  /* ------------------------------------------------------------ providers */

  async listProviders(): Promise<readonly ProviderSettings[]> {
    const result = await this.database.query<ProviderRow>(
      'select * from payment_providers order by provider, mode',
    );
    return result.rows.map(toProvider);
  }

  async readProvider(
    provider: PaymentProviderId,
    mode: 'test' | 'live',
  ): Promise<ProviderSettings | null> {
    const result = await this.database.query<ProviderRow>(
      'select * from payment_providers where provider = $1 and mode = $2',
      [provider, mode],
    );
    const row = result.rows[0];
    return row === undefined ? null : toProvider(row);
  }

  async saveProvider(settings: ProviderSettings): Promise<ProviderSettings> {
    const result = await this.database.query<ProviderRow>(
      `insert into payment_providers (
         provider, mode, display_name, enabled, public_key, secret_key_env,
         webhook_secret_env, currencies, capabilities, version, updated_at, updated_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,1,now(),$10)
       on conflict (provider, mode) do update set
         display_name = excluded.display_name,
         enabled = excluded.enabled,
         public_key = excluded.public_key,
         secret_key_env = excluded.secret_key_env,
         webhook_secret_env = excluded.webhook_secret_env,
         currencies = excluded.currencies,
         capabilities = excluded.capabilities,
         version = payment_providers.version + 1,
         updated_at = now(),
         updated_by = excluded.updated_by
       returning *`,
      [
        settings.provider,
        settings.mode,
        settings.displayName,
        settings.enabled,
        settings.publicKey,
        settings.secretRefs.secretKeyEnv,
        settings.secretRefs.webhookSecretEnv,
        JSON.stringify(settings.currencies),
        JSON.stringify(settings.capabilities),
        settings.updatedBy,
      ],
    );
    return toProvider(result.rows[0] as ProviderRow);
  }

  /* --------------------------------------------------------------- prices */

  async listPrices(): Promise<readonly PriceRecord[]> {
    const result = await this.database.query<PriceRow>(
      'select * from payment_prices order by plan_id, currency, interval',
    );
    return result.rows.map(toPrice);
  }

  async readPrice(id: string): Promise<PriceRecord | null> {
    const result = await this.database.query<PriceRow>(
      'select * from payment_prices where id = $1',
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPrice(row);
  }

  async savePrice(price: PriceRecord): Promise<PriceRecord> {
    const result = await this.database.query<PriceRow>(
      `insert into payment_prices (
         id, plan_id, interval, currency, amount_minor, active, version, updated_by
       ) values ($1,$2,$3,$4,$5,$6,1,$7)
       on conflict (id) do update set
         amount_minor = excluded.amount_minor,
         active = excluded.active,
         version = payment_prices.version + 1,
         updated_at = now(),
         updated_by = excluded.updated_by
       returning *`,
      [
        price.id,
        price.planId,
        price.interval,
        price.currency,
        price.amountMinor,
        price.active,
        price.updatedBy,
      ],
    );
    return toPrice(result.rows[0] as PriceRow);
  }

  /* ------------------------------------------------- discounts and taxes */

  async listDiscounts(): Promise<readonly DiscountRecord[]> {
    const result = await this.database.query<DiscountRow>(
      'select * from payment_discounts order by code',
    );
    return result.rows.map(toDiscount);
  }

  async readDiscount(code: string): Promise<DiscountRecord | null> {
    const result = await this.database.query<DiscountRow>(
      'select * from payment_discounts where code = $1',
      [code.trim().toUpperCase()],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDiscount(row);
  }

  async saveDiscount(discount: DiscountRecord): Promise<DiscountRecord> {
    const result = await this.database.query<DiscountRow>(
      `insert into payment_discounts (
         code, description, percent_off, amount_off_minor, currency, active,
         starts_at, expires_at, max_redemptions, redemptions, updated_by
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (code) do update set
         description = excluded.description,
         percent_off = excluded.percent_off,
         amount_off_minor = excluded.amount_off_minor,
         currency = excluded.currency,
         active = excluded.active,
         starts_at = excluded.starts_at,
         expires_at = excluded.expires_at,
         max_redemptions = excluded.max_redemptions,
         updated_at = now(),
         updated_by = excluded.updated_by
       returning *`,
      [
        discount.code,
        discount.description,
        discount.percentOff,
        discount.amountOffMinor,
        discount.currency,
        discount.active,
        discount.startsAt,
        discount.expiresAt,
        discount.maxRedemptions,
        discount.redemptions,
        discount.updatedBy,
      ],
    );
    return toDiscount(result.rows[0] as DiscountRow);
  }

  async redeemDiscount(code: string): Promise<{ redeemed: number }> {
    const result = await this.database.query<{ redemptions: number }>(
      `update payment_discounts
          set redemptions = redemptions + 1, updated_at = now()
        where code = $1
          and active
          and (max_redemptions is null or redemptions < max_redemptions)
        returning redemptions`,
      [code.trim().toUpperCase()],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('That discount code cannot be redeemed any more.');
    return { redeemed: row.redemptions };
  }

  async listTaxes(): Promise<readonly TaxRecord[]> {
    const result = await this.database.query<TaxRow>(
      'select * from payment_taxes order by country nulls last, name',
    );
    return result.rows.map(toTax);
  }

  async saveTax(tax: TaxRecord): Promise<TaxRecord> {
    const result = await this.database.query<TaxRow>(
      `insert into payment_taxes (id, name, country, rate_bps, active, updated_by)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (id) do update set
         name = excluded.name,
         country = excluded.country,
         rate_bps = excluded.rate_bps,
         active = excluded.active,
         updated_at = now(),
         updated_by = excluded.updated_by
       returning *`,
      [tax.id, tax.name, tax.country, tax.rateBps, tax.active, tax.updatedBy],
    );
    return toTax(result.rows[0] as TaxRow);
  }

  /* ------------------------------------------------------------ customers */

  async readCustomer(ownerRef: string): Promise<BillingCustomer | null> {
    const result = await this.database.query<{
      owner_ref: string;
      email: string;
      name: string;
      country: string | null;
      updated_at: Date;
    }>('select * from billing_customers where owner_ref = $1', [ownerRef]);
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      ownerRef: row.owner_ref,
      email: row.email,
      name: row.name,
      country: row.country,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async saveCustomer(customer: BillingCustomer): Promise<BillingCustomer> {
    assertOwnerMatch(customer.ownerRef);
    const result = await this.database.query<{
      owner_ref: string;
      email: string;
      name: string;
      country: string | null;
      updated_at: Date;
    }>(
      `insert into billing_customers (owner_ref, email, name, country, updated_at)
       values ($1,$2,$3,$4,now())
       on conflict (owner_ref) do update set
         email = excluded.email,
         name = excluded.name,
         country = excluded.country,
         updated_at = now()
       returning *`,
      [customer.ownerRef, customer.email, customer.name, customer.country],
    );
    const row = result.rows[0] as {
      owner_ref: string;
      email: string;
      name: string;
      country: string | null;
      updated_at: Date;
    };
    return {
      ownerRef: row.owner_ref,
      email: row.email,
      name: row.name,
      country: row.country,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /* -------------------------------------------------------------- intents */

  async insertIntent(intent: PaymentIntentRecord): Promise<PaymentIntentRecord> {
    assertOwnerMatch(intent.ownerRef);
    const result = await this.database.query<IntentRow>(
      `insert into payment_intents (
         id, owner_ref, workspace_id, plan_id, interval, kind, provider, mode, currency,
         unit_amount_minor, discount_minor, discount_code, tax_name, tax_rate_bps, tax_minor,
         total_minor, reference, status, created_at, expires_at, paid_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       returning *`,
      [
        intent.id,
        intent.ownerRef,
        intent.workspaceId,
        intent.planId,
        intent.interval,
        intent.kind,
        intent.provider,
        intent.mode,
        intent.currency,
        intent.unitAmountMinor,
        intent.discountMinor,
        intent.discountCode,
        intent.taxName,
        intent.taxRateBps,
        intent.taxMinor,
        intent.totalMinor,
        intent.reference,
        intent.status,
        intent.createdAt,
        intent.expiresAt,
        intent.paidAt,
      ],
    );
    return toIntent(result.rows[0] as IntentRow);
  }

  async readIntent(id: string): Promise<PaymentIntentRecord | null> {
    const result = await this.database.query<IntentRow>(
      'select * from payment_intents where id = $1',
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : toIntent(row);
  }

  async findIntentByReference(reference: string): Promise<PaymentIntentRecord | null> {
    const result = await this.database.query<IntentRow>(
      'select * from payment_intents where reference = $1',
      [reference],
    );
    const row = result.rows[0];
    return row === undefined ? null : toIntent(row);
  }

  async updateIntent(intent: PaymentIntentRecord): Promise<PaymentIntentRecord> {
    assertOwnerMatch(intent.ownerRef);
    const result = await this.database.query<IntentRow>(
      `update payment_intents
          set status = $2, paid_at = $3
        where id = $1
        returning *`,
      [intent.id, intent.status, intent.paidAt],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('That checkout no longer exists.');
    return toIntent(row);
  }

  async listIntents(ownerRef: string, limit = 50): Promise<readonly PaymentIntentRecord[]> {
    const result = await this.database.query<IntentRow>(
      `select * from payment_intents
        where owner_ref = $1
        order by created_at desc
        limit $2`,
      [ownerRef, limit],
    );
    return result.rows.map(toIntent);
  }

  /* --------------------------------------------------------- transactions */

  async insertTransaction(
    transaction: PaymentTransactionRecord,
  ): Promise<PaymentTransactionRecord> {
    assertOwnerMatch(transaction.ownerRef);
    try {
      const result = await this.database.query<TransactionRow>(
        `insert into payment_transactions (
           id, owner_ref, intent_id, provider, mode, provider_reference, amount_minor, currency,
           status, kind, plan_id, interval, verified_at, failure_reason, channel, created_at, updated_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         returning *`,
        [
          transaction.id,
          transaction.ownerRef,
          transaction.intentId,
          transaction.provider,
          transaction.mode,
          transaction.providerReference,
          transaction.amountMinor,
          transaction.currency,
          transaction.status,
          transaction.kind,
          transaction.planId,
          transaction.interval,
          transaction.verifiedAt,
          transaction.failureReason,
          transaction.channel,
          transaction.createdAt,
          transaction.updatedAt,
        ],
      );
      return toTransaction(result.rows[0] as TransactionRow);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new DuplicateReferenceError(transaction.providerReference);
      throw error;
    }
  }

  async readTransaction(id: string): Promise<PaymentTransactionRecord | null> {
    const result = await this.database.query<TransactionRow>(
      'select * from payment_transactions where id = $1',
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : toTransaction(row);
  }

  async findTransactionByReference(reference: string): Promise<PaymentTransactionRecord | null> {
    const result = await this.database.query<TransactionRow>(
      'select * from payment_transactions where provider_reference = $1',
      [reference],
    );
    const row = result.rows[0];
    return row === undefined ? null : toTransaction(row);
  }

  async updateTransaction(
    transaction: PaymentTransactionRecord,
  ): Promise<PaymentTransactionRecord> {
    assertOwnerMatch(transaction.ownerRef);
    const result = await this.database.query<TransactionRow>(
      `update payment_transactions
          set status = $2, verified_at = $3, failure_reason = $4, channel = $5, updated_at = $6
        where id = $1
        returning *`,
      [
        transaction.id,
        transaction.status,
        transaction.verifiedAt,
        transaction.failureReason,
        transaction.channel,
        transaction.updatedAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('That transaction no longer exists.');
    return toTransaction(row);
  }

  async listTransactions(
    ownerRef: string,
    filter?: TransactionFilter,
  ): Promise<readonly PaymentTransactionRecord[]> {
    const result = await this.database.query<TransactionRow>(
      `select * from payment_transactions
        where owner_ref = $1
          and ($2::text is null or status = $2)
          and ($3::text is null or provider = $3)
          and ($4::text is null or kind = $4)
        order by created_at desc
        limit $5 offset $6`,
      [
        ownerRef,
        filter?.status ?? null,
        filter?.provider ?? null,
        filter?.kind ?? null,
        filter?.limit ?? 100,
        filter?.skip ?? 0,
      ],
    );
    return result.rows.map(toTransaction);
  }

  /** Operator surface only: no owner predicate, and never used by an owner route. */
  async listAllTransactions(
    filter?: TransactionFilter,
  ): Promise<readonly PaymentTransactionRecord[]> {
    const result = await this.database.query<TransactionRow>(
      `select * from payment_transactions
        where ($1::text is null or status = $1)
          and ($2::text is null or provider = $2)
        order by created_at desc
        limit $3 offset $4`,
      [filter?.status ?? null, filter?.provider ?? null, filter?.limit ?? 200, filter?.skip ?? 0],
    );
    return result.rows.map(toTransaction);
  }

  /* ------------------------------------------------------ payment methods */

  async savePaymentMethod(method: PaymentMethodRecord): Promise<PaymentMethodRecord> {
    assertOwnerMatch(method.ownerRef);
    const result = await this.database.query<{
      owner_ref: string;
      id: string;
      provider: PaymentProviderId;
      mode: 'test' | 'live';
      authorization_code: string;
      brand: string | null;
      last4: string | null;
      exp_month: string | null;
      exp_year: string | null;
      reusable: boolean;
      created_at: Date;
    }>(
      `insert into payment_methods (
         owner_ref, id, provider, mode, authorization_code, brand, last4,
         exp_month, exp_year, reusable, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (owner_ref) do update set
         id = excluded.id,
         provider = excluded.provider,
         mode = excluded.mode,
         authorization_code = excluded.authorization_code,
         brand = excluded.brand,
         last4 = excluded.last4,
         exp_month = excluded.exp_month,
         exp_year = excluded.exp_year,
         reusable = excluded.reusable,
         created_at = excluded.created_at
       returning *`,
      [
        method.ownerRef,
        method.id,
        method.provider,
        method.mode,
        method.authorizationCode,
        method.brand,
        method.last4,
        method.expMonth,
        method.expYear,
        method.reusable,
        method.createdAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('The payment method was not saved.');
    return {
      id: row.id,
      ownerRef: row.owner_ref,
      provider: row.provider,
      mode: row.mode,
      authorizationCode: row.authorization_code,
      brand: row.brand,
      last4: row.last4,
      expMonth: row.exp_month,
      expYear: row.exp_year,
      reusable: row.reusable,
      createdAt: row.created_at.toISOString(),
    };
  }

  async readPaymentMethod(ownerRef: string): Promise<PaymentMethodRecord | null> {
    const result = await this.database.query<{
      owner_ref: string;
      id: string;
      provider: PaymentProviderId;
      mode: 'test' | 'live';
      authorization_code: string;
      brand: string | null;
      last4: string | null;
      exp_month: string | null;
      exp_year: string | null;
      reusable: boolean;
      created_at: Date;
    }>('select * from payment_methods where owner_ref = $1', [ownerRef]);
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      ownerRef: row.owner_ref,
      provider: row.provider,
      mode: row.mode,
      authorizationCode: row.authorization_code,
      brand: row.brand,
      last4: row.last4,
      expMonth: row.exp_month,
      expYear: row.exp_year,
      reusable: row.reusable,
      createdAt: row.created_at.toISOString(),
    };
  }

  async clearPaymentMethod(ownerRef: string): Promise<void> {
    await this.database.query('delete from payment_methods where owner_ref = $1', [ownerRef]);
  }

  /* ------------------------------------------------------------- invoices */

  async nextInvoiceSequence(year: number): Promise<number> {
    const result = await this.database.query<{ value: string | number }>(
      `insert into payment_invoice_counters (year, value)
       values ($1, 1)
       on conflict (year) do update set value = payment_invoice_counters.value + 1
       returning value`,
      [year],
    );
    const row = result.rows[0];
    return num(row?.value ?? 0);
  }

  async insertInvoice(invoice: InvoiceRecord): Promise<InvoiceRecord> {
    assertOwnerMatch(invoice.ownerRef);
    try {
      const result = await this.database.query<InvoiceRow>(
        `insert into invoices (
           id, number, owner_ref, workspace_id, plan_id, plan_name, interval, currency,
           unit_amount_minor, discount_minor, subtotal_minor, tax_name, tax_rate_bps, tax_minor,
           total_minor, status, customer_name, customer_email, customer_address, issued_at,
           due_at, paid_at, transaction_reference, provider, notes, created_at, updated_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                   $21,$22,$23,$24,$25::jsonb,$26,$27)
         returning *`,
        [
          invoice.id,
          invoice.number,
          invoice.ownerRef,
          invoice.workspaceId,
          invoice.planId,
          invoice.planName,
          invoice.interval,
          invoice.currency,
          invoice.unitAmountMinor,
          invoice.discountMinor,
          invoice.subtotalMinor,
          invoice.taxName,
          invoice.taxRateBps,
          invoice.taxMinor,
          invoice.totalMinor,
          invoice.status,
          invoice.customerName,
          invoice.customerEmail,
          invoice.customerAddress,
          invoice.issuedAt,
          invoice.dueAt,
          invoice.paidAt,
          invoice.transactionReference,
          invoice.provider,
          JSON.stringify(invoice.notes),
          invoice.createdAt,
          invoice.updatedAt,
        ],
      );
      return toInvoice(result.rows[0] as InvoiceRow);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DatabaseError('conflict', 'That invoice number already exists.', {
          sqlState: UNIQUE_VIOLATION,
        });
      }
      throw error;
    }
  }

  async readInvoice(id: string): Promise<InvoiceRecord | null> {
    const result = await this.database.query<InvoiceRow>('select * from invoices where id = $1', [
      id,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toInvoice(row);
  }

  async findInvoiceByNumber(number: string): Promise<InvoiceRecord | null> {
    const result = await this.database.query<InvoiceRow>(
      'select * from invoices where number = $1',
      [number],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInvoice(row);
  }

  async updateInvoice(invoice: InvoiceRecord): Promise<InvoiceRecord> {
    assertOwnerMatch(invoice.ownerRef);
    const result = await this.database.query<InvoiceRow>(
      `update invoices
          set status = $2, paid_at = $3, transaction_reference = $4, provider = $5,
              updated_at = $6
        where id = $1
        returning *`,
      [
        invoice.id,
        invoice.status,
        invoice.paidAt,
        invoice.transactionReference,
        invoice.provider,
        invoice.updatedAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('That invoice no longer exists.');
    return toInvoice(row);
  }

  async listInvoices(ownerRef: string, filter?: InvoiceFilter): Promise<readonly InvoiceRecord[]> {
    const result = await this.database.query<InvoiceRow>(
      `select * from invoices
        where owner_ref = $1 and ($2::text is null or status = $2)
        order by issued_at desc
        limit $3 offset $4`,
      [ownerRef, filter?.status ?? null, filter?.limit ?? 100, filter?.skip ?? 0],
    );
    return result.rows.map(toInvoice);
  }

  /* -------------------------------------------------------------- refunds */

  async insertRefund(refund: RefundRecord): Promise<RefundRecord> {
    assertOwnerMatch(refund.ownerRef);
    try {
      const result = await this.database.query<RefundRow>(
        `insert into payment_refunds (
           id, owner_ref, transaction_id, provider, mode, amount_minor, currency, reason,
           status, provider_reference, requested_by, approved_by, note, created_at, updated_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         returning *`,
        [
          refund.id,
          refund.ownerRef,
          refund.transactionId,
          refund.provider,
          refund.mode,
          refund.amountMinor,
          refund.currency,
          refund.reason,
          refund.status,
          refund.providerReference,
          refund.requestedBy,
          refund.approvedBy,
          refund.note,
          refund.createdAt,
          refund.updatedAt,
        ],
      );
      return toRefund(result.rows[0] as RefundRow);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateReferenceError(refund.providerReference ?? 'refund');
      }
      throw error;
    }
  }

  async readRefund(id: string): Promise<RefundRecord | null> {
    const result = await this.database.query<RefundRow>(
      'select * from payment_refunds where id = $1',
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRefund(row);
  }

  async updateRefund(refund: RefundRecord): Promise<RefundRecord> {
    assertOwnerMatch(refund.ownerRef);
    try {
      const result = await this.database.query<RefundRow>(
        `update payment_refunds
            set status = $2, provider_reference = $3, approved_by = $4, note = $5, updated_at = $6
          where id = $1
          returning *`,
        [
          refund.id,
          refund.status,
          refund.providerReference,
          refund.approvedBy,
          refund.note,
          refund.updatedAt,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('That refund no longer exists.');
      return toRefund(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateReferenceError(refund.providerReference ?? 'refund');
      }
      throw error;
    }
  }

  async listRefunds(ownerRef: string, limit = 100): Promise<readonly RefundRecord[]> {
    const result = await this.database.query<RefundRow>(
      `select * from payment_refunds
        where owner_ref = $1
        order by created_at desc
        limit $2`,
      [ownerRef, limit],
    );
    return result.rows.map(toRefund);
  }

  async listRefundsForTransaction(transactionId: string): Promise<readonly RefundRecord[]> {
    const result = await this.database.query<RefundRow>(
      'select * from payment_refunds where transaction_id = $1 order by created_at',
      [transactionId],
    );
    return result.rows.map(toRefund);
  }

  async findRefundByProviderReference(reference: string): Promise<RefundRecord | null> {
    const result = await this.database.query<RefundRow>(
      'select * from payment_refunds where provider_reference = $1',
      [reference],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRefund(row);
  }

  /* --------------------------------------------------------------- events */

  async insertEvent(event: PaymentEventRecord): Promise<{ created: boolean }> {
    const result = await this.database.query<{ id: string }>(
      `insert into payment_events (
         id, owner_ref, provider, mode, event_type, dedupe_key, reference,
         signature_valid, status, note, attempts, received_at, processed_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (coalesce(owner_ref, '*'), dedupe_key) do nothing
       returning id`,
      [
        event.id,
        event.ownerRef,
        event.provider,
        event.mode,
        event.eventType,
        event.dedupeKey,
        event.reference,
        event.signatureValid,
        event.status,
        event.note,
        event.attempts,
        event.receivedAt,
        event.processedAt,
      ],
    );
    return { created: result.rows.length > 0 };
  }

  async updateEvent(event: PaymentEventRecord): Promise<PaymentEventRecord> {
    const result = await this.database.query<EventRow>(
      `update payment_events
          set status = $2, note = $3, attempts = $4, processed_at = $5, owner_ref = coalesce($6, owner_ref)
        where id = $1
        returning *`,
      [event.id, event.status, event.note, event.attempts, event.processedAt, event.ownerRef],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('That event no longer exists.');
    return toEvent(row);
  }

  async listEvents(filter?: EventFilter): Promise<readonly PaymentEventRecord[]> {
    const result = await this.database.query<EventRow>(
      `select * from payment_events
        where ($1::text is null or provider = $1)
          and ($2::text is null or status = $2)
        order by received_at desc
        limit $3 offset $4`,
      [filter?.provider ?? null, filter?.status ?? null, filter?.limit ?? 100, filter?.skip ?? 0],
    );
    return result.rows.map(toEvent);
  }

  /* -------------------------------------------------- notifications, audit */

  async insertNotification(notification: BillingNotificationRecord): Promise<{ created: boolean }> {
    assertOwnerMatch(notification.ownerRef);
    const result = await this.database.query<{ id: string }>(
      `insert into billing_notifications (
         id, owner_ref, kind, dedupe_key, title, message, subject_id, created_at, read_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (owner_ref, dedupe_key) do nothing
       returning id`,
      [
        notification.id,
        notification.ownerRef,
        notification.kind,
        notification.dedupeKey,
        notification.title,
        notification.message,
        notification.subjectId,
        notification.createdAt,
        notification.readAt,
      ],
    );
    return { created: result.rows.length > 0 };
  }

  async listNotifications(
    ownerRef: string,
    filter?: NotificationFilter,
  ): Promise<readonly BillingNotificationRecord[]> {
    const result = await this.database.query<NotificationRow>(
      `select * from billing_notifications
        where owner_ref = $1
          and ($2::boolean is not true or read_at is null)
        order by created_at desc
        limit $3`,
      [ownerRef, filter?.unreadOnly ?? false, filter?.limit ?? 50],
    );
    return result.rows.map(toNotification);
  }

  async markNotificationsRead(ownerRef: string, ids?: readonly string[]): Promise<number> {
    const result = await this.database.query<{ id: string }>(
      `update billing_notifications
          set read_at = now()
        where owner_ref = $1
          and read_at is null
          and ($2::text[] is null or id = any($2::text[]))
        returning id`,
      [ownerRef, ids === undefined ? null : [...ids]],
    );
    return result.rows.length;
  }

  async appendAudit(record: BillingAuditRecord): Promise<void> {
    await this.database.query(
      `insert into billing_audit (id, scope, owner_ref, action, actor, subject, detail, at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [
        record.id,
        record.scope,
        record.ownerRef,
        record.action,
        record.actor,
        record.subject,
        JSON.stringify(record.detail),
        record.at,
      ],
    );
  }

  async listAudit(ownerRef: string, limit = 200): Promise<readonly BillingAuditRecord[]> {
    const result = await this.database.query<AuditRow>(
      `select * from billing_audit
        where owner_ref = $1
        order by at desc
        limit $2`,
      [ownerRef, limit],
    );
    return result.rows.map(toAudit);
  }

  async listPlatformAudit(limit = 200): Promise<readonly BillingAuditRecord[]> {
    const result = await this.database.query<AuditRow>(
      `select * from billing_audit
        where scope = 'platform'
        order by at desc
        limit $1`,
      [limit],
    );
    return result.rows.map(toAudit);
  }

  async listTransactionsByMode(
    mode: 'test' | 'live',
  ): Promise<readonly PaymentTransactionRecord[]> {
    const result = await this.database.query<TransactionRow>(
      `select * from payment_transactions
        where mode = $1
        order by created_at desc
        limit 200`,
      [mode],
    );
    return result.rows.map(toTransaction);
  }
}
