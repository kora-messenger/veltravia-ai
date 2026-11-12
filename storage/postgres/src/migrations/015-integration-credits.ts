/**
 * Integration credits (Step 56).
 *
 * Two tables:
 *
 *  - `integration_charges` is the audit of one billable external operation: who,
 *    where, which integration, connector, operation and execution, what was
 *    measured, what was charged, and what could not be measured.
 *    `(owner_ref, idempotency_key)` is unique, so a retried operation finds its
 *    first row instead of charging twice. The state column moves forward only
 *    (reserved -> committed | released | exempt -> refunded); the rows are never
 *    deleted and never rewritten with a different amount.
 *  - `integration_credit_settings` is a user's own spending ceiling for
 *    integration work. An empty `workspace_id` means the personal wallet.
 *
 * Money stays in `wallet_entries` (Step 53): a committed charge points at the
 * ledger row it produced, and a refund goes through the wallet's refund path,
 * so there is still exactly one place that says what a balance is.
 */

export const migration015 = {
  version: '015',
  name: 'integration-credits',
  sql: `
create table if not exists integration_charges (
  owner_ref text not null check (owner_ref <> ''),
  id text not null,
  workspace_id text null,
  project_id text null,
  integration_id text null,
  connector_id text null,
  plugin_id text null,
  operation_id text null,
  execution_id text null,
  request_id text null,
  connection_id text null,
  kind text not null check (kind in (
    'integration.operation', 'connector.operation',
    'plugin.operation', 'external.service'
  )),
  billing_class text not null check (billing_class in ('free', 'paid', 'externally-billed')),
  plan_id text not null,
  policy_id text not null,
  credits numeric(18, 4) not null default 0 check (credits >= 0),
  estimated_credits numeric(18, 4) not null default 0 check (estimated_credits >= 0),
  state text not null check (state in ('reserved', 'committed', 'released', 'exempt', 'refunded')),
  basis text not null check (basis in ('flat', 'usage', 'flat+usage', 'unmeasured', 'exempt')),
  requests integer null check (requests is null or requests >= 0),
  units jsonb not null default '{}'::jsonb,
  duration_ms bigint null check (duration_ms is null or duration_ms >= 0),
  limitations jsonb not null default '[]'::jsonb,
  measurement_source text null
    check (measurement_source is null or measurement_source in ('platform', 'connector', 'unavailable')),
  byok boolean not null default false,
  idempotency_key text not null check (idempotency_key <> ''),
  reservation_id text null,
  wallet_entry_id text null,
  failure_reason text null,
  created_at timestamptz not null,
  settled_at timestamptz null,
  refunded_at timestamptz null,
  primary key (owner_ref, id),
  unique (owner_ref, idempotency_key)
);

create index if not exists integration_charges_recent
  on integration_charges (owner_ref, created_at desc);
create index if not exists integration_charges_integration
  on integration_charges (owner_ref, integration_id, created_at desc);
create index if not exists integration_charges_execution
  on integration_charges (owner_ref, execution_id, created_at desc);
create index if not exists integration_charges_open
  on integration_charges (owner_ref, state) where state = 'reserved';

create table if not exists integration_credit_settings (
  owner_ref text not null check (owner_ref <> ''),
  workspace_id text not null default '',
  monthly_limit numeric(18, 4) null check (monthly_limit is null or monthly_limit >= 0),
  per_operation_limit numeric(18, 4) null
    check (per_operation_limit is null or per_operation_limit >= 0),
  updated_at timestamptz not null default now(),
  primary key (owner_ref, workspace_id)
);
`,
} as const;
