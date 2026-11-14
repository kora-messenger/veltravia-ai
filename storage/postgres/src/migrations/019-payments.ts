/**
 * Payments, invoices and refunds (Step 61).
 *
 * Nine tables, and the constraints are the security model:
 *
 *  - `payment_providers` holds **configuration, never a secret**. It stores the
 *    *names* of the environment variables a deployment keeps its keys in, so a
 *    database dump cannot be replayed against a provider. The publishable key is
 *    a separate column because that one is allowed to reach a browser.
 *  - `payment_prices` is unique per `(plan, interval, currency)` and references
 *    the plan catalogue, so a price for a plan that does not exist cannot be
 *    written and two prices for one product cannot both be live.
 *  - `payment_discounts` has a check constraint that exactly one of percentage
 *    or fixed amount is set. A discount that is both is a configuration mistake
 *    the database refuses rather than the server guessing.
 *  - `payment_intents` is the server's own record of a checkout: the amount it
 *    decided, the tax it applied and the reference it will verify. `reference`
 *    is unique.
 *  - `payment_transactions.provider_reference` is **unique**, which is what
 *    makes a reference single-use and a duplicate payment impossible. A charge
 *    row can only ever be written once per provider reference.
 *  - `payment_methods` stores an authorization token, a brand and four digits.
 *    There is no column for a card number or a CVV anywhere in this migration,
 *    because this build never sees one: the customer pays on the provider's
 *    hosted page.
 *  - `payment_invoice_counters` is the atomic source of invoice numbers, one row
 *    per year, incremented inside the same transaction that inserts the invoice.
 *  - `invoices` copies every amount at issue time, so a later price change cannot
 *    rewrite a paid invoice.
 *  - `payment_refunds` has a unique provider reference and an amount check, and
 *    the service additionally refuses a total above what the transaction charged.
 *  - `payment_events` is unique per `(owner-or-global, dedupe_key)`, so a
 *    duplicate webhook delivery is recorded once and acted on once.
 *  - `billing_notifications` is unique per `(owner, dedupe_key)`, so a retried job
 *    notifies once.
 *  - `billing_audit` is append-only by construction: there is no update path in
 *    the store for it.
 */

export const migration019 = {
  version: '019',
  name: 'payments-invoices-refunds',
  sql: `
create table if not exists payment_providers (
  provider text not null check (provider in ('paystack', 'flutterwave', 'monnify')),
  mode text not null check (mode in ('test', 'live')),
  display_name text not null default '',
  enabled boolean not null default false,
  public_key text,
  -- Names, not values. The secret itself lives in the deployment's store.
  secret_key_env text not null default '',
  webhook_secret_env text not null default '',
  currencies jsonb not null default '[]'::jsonb,
  capabilities jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version >= 1),
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  primary key (provider, mode),
  constraint payment_providers_secret_is_a_name
    check (secret_key_env = '' or secret_key_env ~ '^[A-Z][A-Z0-9_]*$'),
  constraint payment_providers_webhook_is_a_name
    check (webhook_secret_env = '' or webhook_secret_env ~ '^[A-Z][A-Z0-9_]*$')
);

create table if not exists payment_prices (
  id text primary key,
  plan_id text not null references subscription_plans (plan_id) on delete restrict,
  interval text not null check (interval in ('monthly', 'yearly')),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor >= 0),
  active boolean not null default true,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  constraint payment_prices_one_per_product unique (plan_id, interval, currency)
);

create index if not exists payment_prices_by_plan on payment_prices (plan_id, currency);

create table if not exists payment_discounts (
  code text primary key check (code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  description text not null default '',
  percent_off integer not null default 0 check (percent_off between 0 and 100),
  amount_off_minor bigint check (amount_off_minor is null or amount_off_minor > 0),
  currency char(3) check (currency is null or currency ~ '^[A-Z]{3}$'),
  active boolean not null default true,
  starts_at timestamptz,
  expires_at timestamptz,
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
  redemptions integer not null default 0 check (redemptions >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  -- Exactly one kind of discount: a percentage XOR a fixed amount.
  constraint payment_discounts_exactly_one
    check ((percent_off > 0 and amount_off_minor is null)
        or (percent_off = 0 and amount_off_minor is not null)),
  constraint payment_discounts_currency_for_amount
    check (amount_off_minor is null or currency is not null),
  constraint payment_discounts_window
    check (starts_at is null or expires_at is null or expires_at > starts_at)
);

create table if not exists payment_taxes (
  id text primary key,
  name text not null check (name <> ''),
  country char(2) check (country is null or country ~ '^[A-Z]{2}$'),
  rate_bps integer not null check (rate_bps between 0 and 10000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

create unique index if not exists payment_taxes_one_per_country
  on payment_taxes (coalesce(country, '*')) where active;

create table if not exists payment_intents (
  id text primary key,
  owner_ref text not null,
  workspace_id text,
  plan_id text not null,
  interval text not null check (interval in ('monthly', 'yearly')),
  kind text not null check (kind in ('initial', 'renewal', 'upgrade', 'change', 'topup')),
  provider text not null check (provider in ('paystack', 'flutterwave', 'monnify')),
  mode text not null check (mode in ('test', 'live')),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  unit_amount_minor bigint not null check (unit_amount_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  discount_code text,
  tax_name text,
  tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 10000),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  reference text not null unique,
  status text not null default 'open'
    check (status in ('open', 'paid', 'expired', 'cancelled', 'failed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  paid_at timestamptz,
  constraint payment_intents_discount_not_above_price check (discount_minor <= unit_amount_minor),
  constraint payment_intents_total_adds_up
    check (total_minor = unit_amount_minor - discount_minor + tax_minor),
  constraint payment_intents_expiry_after_creation check (expires_at > created_at)
);

create index if not exists payment_intents_by_owner
  on payment_intents (owner_ref, created_at desc);

create table if not exists payment_transactions (
  id text primary key,
  owner_ref text not null,
  intent_id text not null references payment_intents (id) on delete restrict,
  provider text not null check (provider in ('paystack', 'flutterwave', 'monnify')),
  mode text not null check (mode in ('test', 'live')),
  provider_reference text not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  status text not null
    check (status in ('pending', 'succeeded', 'failed', 'abandoned', 'refunded', 'partially_refunded')),
  kind text not null check (kind in ('initial', 'renewal', 'upgrade', 'change', 'topup')),
  plan_id text not null,
  interval text not null check (interval in ('monthly', 'yearly')),
  verified_at timestamptz,
  failure_reason text,
  channel text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The single-use rule. A replayed reference cannot become a second payment.
  constraint payment_transactions_reference_once unique (provider_reference)
);

create index if not exists payment_transactions_by_owner
  on payment_transactions (owner_ref, created_at desc);

create index if not exists payment_transactions_by_intent
  on payment_transactions (intent_id);

create table if not exists payment_methods (
  owner_ref text primary key,
  id text not null,
  provider text not null check (provider in ('paystack', 'flutterwave', 'monnify')),
  mode text not null check (mode in ('test', 'live')),
  authorization_code text not null,
  brand text,
  -- Four digits is all this build keeps. No PAN column, no CVV column.
  last4 char(4) check (last4 is null or last4 ~ '^[0-9]{4}$'),
  exp_month text,
  exp_year text,
  reusable boolean not null default false,
  created_at timestamptz not null default now()
);

-- The billing profile a customer gives at checkout. Deliberately separate from
-- any account record: this build has no user table to lean on, and an invoice
-- needs a name and an email that the buyer actually supplied.
create table if not exists billing_customers (
  owner_ref text primary key,
  email text not null check (email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  name text not null default '',
  country char(2) check (country is null or country ~ '^[A-Z]{2}$'),
  updated_at timestamptz not null default now()
);

create table if not exists payment_invoice_counters (
  year integer primary key check (year between 2000 and 9999),
  value bigint not null default 0 check (value >= 0)
);

create table if not exists invoices (
  id text primary key,
  number text not null unique,
  owner_ref text not null,
  workspace_id text,
  plan_id text not null,
  plan_name text not null,
  interval text not null check (interval in ('monthly', 'yearly')),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  unit_amount_minor bigint not null check (unit_amount_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  tax_name text,
  tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 10000),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  status text not null
    check (status in ('draft', 'issued', 'paid', 'failed', 'cancelled', 'refunded')),
  customer_name text not null default '',
  customer_email text not null default '',
  customer_address text,
  issued_at timestamptz not null,
  due_at timestamptz,
  paid_at timestamptz,
  transaction_reference text,
  provider text check (provider is null or provider in ('paystack', 'flutterwave', 'monnify')),
  notes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoices_total_adds_up
    check (total_minor = unit_amount_minor - discount_minor + tax_minor)
);

create index if not exists invoices_by_owner on invoices (owner_ref, issued_at desc);
create index if not exists invoices_by_status on invoices (status);

create table if not exists payment_refunds (
  id text primary key,
  owner_ref text not null,
  transaction_id text not null references payment_transactions (id) on delete restrict,
  provider text not null check (provider in ('paystack', 'flutterwave', 'monnify')),
  mode text not null check (mode in ('test', 'live')),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  reason text not null check (reason <> ''),
  status text not null check (status in ('requested', 'pending', 'succeeded', 'failed')),
  provider_reference text,
  requested_by text not null,
  approved_by text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_refunds_one_per_provider_reference unique (provider_reference)
);

create index if not exists payment_refunds_by_owner
  on payment_refunds (owner_ref, created_at desc);
create index if not exists payment_refunds_by_transaction
  on payment_refunds (transaction_id);

create table if not exists payment_events (
  id text primary key,
  owner_ref text,
  provider text not null check (provider in ('paystack', 'flutterwave', 'monnify')),
  mode text not null check (mode in ('test', 'live')),
  event_type text not null default '',
  dedupe_key text not null,
  reference text,
  signature_valid boolean not null default false,
  status text not null
    check (status in ('received', 'processed', 'duplicate', 'ignored', 'failed', 'rejected')),
  note text,
  attempts integer not null default 1 check (attempts >= 1),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create unique index if not exists payment_events_once
  on payment_events (coalesce(owner_ref, '*'), dedupe_key);

create index if not exists payment_events_by_received
  on payment_events (received_at desc);

create table if not exists billing_notifications (
  id text primary key,
  owner_ref text not null,
  kind text not null,
  dedupe_key text not null,
  title text not null default '',
  message text not null default '',
  subject_id text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint billing_notifications_once unique (owner_ref, dedupe_key)
);

create index if not exists billing_notifications_by_owner
  on billing_notifications (owner_ref, created_at desc);

create table if not exists billing_audit (
  id text primary key,
  scope text not null check (scope in ('platform', 'owner')),
  owner_ref text not null default '',
  action text not null,
  actor text not null default '',
  subject text not null default '',
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create index if not exists billing_audit_by_owner
  on billing_audit (owner_ref, at desc);
create index if not exists billing_audit_by_scope
  on billing_audit (scope, at desc);
`,
} as const;
