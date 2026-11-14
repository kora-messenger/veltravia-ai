/**
 * Subscriptions (Step 60).
 *
 * Five tables, and none of them is a ledger:
 *
 *  - `subscription_plans` is **global configuration**, not per-owner data: the
 *    catalogue is one row per plan, editable only by an operator. It carries the
 *    entitlements and the quotas as JSON so a new plan is a row, not a release,
 *    and the numbers are `check (>= 0)` because a negative ceiling is a bug.
 *  - `subscriptions` is one row per account, with the plan, the status and the
 *    current period. The foreign key to the catalogue means a subscription can
 *    never name a plan that is not there, and `on delete restrict` means a plan
 *    with subscribers cannot be deleted out from under them (deactivate it
 *    instead). `current_period_end > current_period_start` is a check, not a
 *    hope.
 *  - `subscription_periods` is the idempotency record for monthly processing:
 *    `(owner_ref, period_start)` is the primary key, so a retried renewal job
 *    cannot advance the same period twice, and the insert reports whether it
 *    created the row.
 *  - `subscription_events` is what a person is told. `(owner_ref, dedupe_key)` is
 *    unique, so a retried job notifies once.
 *  - `subscription_audit` is the who-changed-what record, with the previous and
 *    next state kept as JSON beside the actor and the reason. `scope` separates
 *    catalogue changes (platform) from an account's own history (owner).
 *
 * Credits are not stored here. A plan is a ceiling; the wallet and the two charge
 * lanes keep being the only place a balance or a charge exists.
 */

export const migration018 = {
  version: '018',
  name: 'subscriptions',
  sql: `
create table if not exists subscription_plans (
  plan_id text primary key check (plan_id ~ '^[a-z][a-z0-9-]{1,31}$'),
  name text not null check (name <> ''),
  description text not null default '',
  rank integer not null default 0 check (rank >= 0),
  visible boolean not null default true,
  active boolean not null default true,
  self_service boolean not null default false,
  monthly_message_credits integer not null default 0 check (monthly_message_credits >= 0),
  monthly_integration_credits integer not null default 0
    check (monthly_integration_credits >= 0),
  entitlements jsonb not null default '{}'::jsonb,
  quotas jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version >= 1),
  built_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null default '',
  -- Only an inactive plan may be one nobody can be moved onto.
  constraint subscription_plans_self_service
    check (not self_service or active)
);

create index if not exists subscription_plans_catalogue
  on subscription_plans (active, visible, rank);

create table if not exists subscriptions (
  owner_ref text primary key check (owner_ref <> ''),
  id text not null unique,
  plan_id text not null references subscription_plans (plan_id) on delete restrict,
  status text not null check (status in (
    'active', 'trialing', 'past_due', 'suspended', 'canceled', 'expired'
  )),
  started_at timestamptz not null,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  renews boolean not null default true,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz null,
  suspended_at timestamptz null,
  suspension_reason text null,
  expired_at timestamptz null,
  last_changed_at timestamptz not null,
  last_changed_by text not null default '',
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_period_order check (current_period_end > current_period_start),
  -- A suspended row always names when it was held; a live row never does.
  constraint subscriptions_suspended_at check (status <> 'suspended' or suspended_at is not null)
);

create index if not exists subscriptions_by_plan on subscriptions (plan_id);
create index if not exists subscriptions_by_status on subscriptions (status);
create index if not exists subscriptions_period_end on subscriptions (current_period_end);

create table if not exists subscription_periods (
  owner_ref text not null check (owner_ref <> ''),
  period_start timestamptz not null,
  period_end timestamptz not null,
  plan_id text not null,
  message_credits integer not null default 0 check (message_credits >= 0),
  integration_credits integer not null default 0 check (integration_credits >= 0),
  kind text not null check (kind in ('assignment', 'renewal')),
  actor text not null default '',
  processed_at timestamptz not null,
  primary key (owner_ref, period_start),
  constraint subscription_periods_order check (period_end > period_start)
);

create table if not exists subscription_events (
  owner_ref text not null check (owner_ref <> ''),
  id text not null,
  kind text not null check (kind in (
    'assigned', 'upgraded', 'downgraded', 'renewed', 'canceled',
    'suspended', 'reactivated', 'expired', 'entitlements-changed', 'plan-changed'
  )),
  plan_id text not null,
  previous_plan_id text null,
  status text not null,
  message text not null,
  actor text not null default '',
  dedupe_key text not null check (dedupe_key <> ''),
  occurred_at timestamptz not null,
  primary key (owner_ref, id),
  unique (owner_ref, dedupe_key)
);

create index if not exists subscription_events_recent
  on subscription_events (owner_ref, occurred_at desc);

create table if not exists subscription_audit (
  owner_ref text not null check (owner_ref <> ''),
  id text not null,
  scope text not null default 'owner' check (scope in ('owner', 'platform')),
  action text not null check (action in (
    'plan-created', 'plan-updated', 'plan-activated', 'plan-deactivated',
    'subscription-assigned', 'subscription-plan-changed', 'subscription-suspended',
    'subscription-reactivated', 'subscription-canceled', 'subscription-expired',
    'subscription-renewed'
  )),
  actor text not null default '',
  reason text not null default '',
  previous_state jsonb null,
  next_state jsonb null,
  occurred_at timestamptz not null,
  primary key (owner_ref, id)
);

create index if not exists subscription_audit_recent
  on subscription_audit (owner_ref, occurred_at desc);
create index if not exists subscription_audit_platform
  on subscription_audit (scope, occurred_at desc);
`,
} as const;
