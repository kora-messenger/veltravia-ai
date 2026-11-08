/**
 * Usage metering (Step 52).
 *
 * Four tables, deliberately append-only where it matters:
 *
 *  - `usage_records` is what happened. `(owner_ref, operation_key)` is the
 *    primary key, so one operation is metered once even when a worker retries or
 *    a request is replayed. Nothing updates a quantity in place; a correction is
 *    a new row in `usage_adjustments`.
 *  - `usage_reservations` is capacity claimed before work starts. The claim
 *    statement is a single `insert ... select ... where held + qty <= limit`,
 *    which is what makes a concurrency limit hold under two concurrent requests.
 *  - `usage_adjustments` is the audit trail for corrections, keyed by
 *    `(owner_ref, audit_id)` so an adjustment cannot be applied twice.
 *  - `usage_quota_overrides` is configuration: a limit set for one owner or one
 *    project, in the units the catalog uses.
 *
 * No table here duplicates a task, worker, verification, integration, recovery
 * or reliability record. A usage row points at them; it does not replace them.
 */

export const migration011 = {
  version: '011',
  name: 'usage-metering',
  sql: `
create table if not exists usage_records (
  owner_ref text not null check (owner_ref <> ''),
  operation_key text not null check (operation_key <> ''),
  id text not null,
  project_id text null,
  category text not null check (category in (
    'database_storage', 'backend_execution', 'file_storage', 'bandwidth',
    'hosting', 'background_jobs', 'realtime', 'ai_provider'
  )),
  operation text not null check (operation <> ''),
  resource text not null,
  quantity numeric(24, 3) not null check (quantity >= 0),
  unit text not null check (unit in ('bytes', 'milliseconds', 'calls', 'connections', 'tokens')),
  occurred_at timestamptz not null,
  environment text not null check (environment in ('development', 'production')),
  cost_class text not null check (cost_class in ('infrastructure', 'provider')),
  cost_bearer text not null check (cost_bearer in ('veltravia', 'user_provider', 'none')),
  provider_id text null,
  model_id text null,
  allowance text null,
  cost_usd numeric(18, 8) null,
  cost_source text not null check (cost_source in ('provider_reported', 'price_table', 'unknown')),
  source text not null check (source in ('measured', 'provider_reported', 'derived', 'estimated')),
  status text not null check (status in ('recorded', 'excluded', 'reconciled')),
  execution_id text null,
  task_id text null,
  worker_id text null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (owner_ref, operation_key)
);

create index if not exists usage_records_owner_time_idx
  on usage_records (owner_ref, occurred_at desc);

create index if not exists usage_records_project_time_idx
  on usage_records (owner_ref, project_id, occurred_at desc);

create index if not exists usage_records_category_time_idx
  on usage_records (owner_ref, category, occurred_at desc);

create table if not exists usage_reservations (
  owner_ref text not null check (owner_ref <> ''),
  operation_key text not null check (operation_key <> ''),
  id text not null,
  project_id text null,
  category text not null check (category in (
    'database_storage', 'backend_execution', 'file_storage', 'bandwidth',
    'hosting', 'background_jobs', 'realtime', 'ai_provider'
  )),
  quantity numeric(24, 3) not null check (quantity >= 0),
  unit text not null check (unit in ('bytes', 'milliseconds', 'calls', 'connections', 'tokens')),
  operation_id text null,
  status text not null check (status in ('held', 'committed', 'released', 'expired')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  settled_at timestamptz null,
  note text null,
  primary key (owner_ref, operation_key)
);

create index if not exists usage_reservations_live_idx
  on usage_reservations (owner_ref, category, status, expires_at);

create table if not exists usage_adjustments (
  owner_ref text not null check (owner_ref <> ''),
  audit_id text not null check (audit_id <> ''),
  id text not null,
  project_id text null,
  category text not null check (category in (
    'database_storage', 'backend_execution', 'file_storage', 'bandwidth',
    'hosting', 'background_jobs', 'realtime', 'ai_provider'
  )),
  quantity numeric(24, 3) not null,
  unit text not null check (unit in ('bytes', 'milliseconds', 'calls', 'connections', 'tokens')),
  reason text not null check (length(reason) >= 8),
  actor text not null check (actor <> ''),
  recorded_at timestamptz not null,
  target_record_id text null,
  primary key (owner_ref, audit_id)
);

create index if not exists usage_adjustments_owner_time_idx
  on usage_adjustments (owner_ref, recorded_at desc);

create table if not exists usage_quota_overrides (
  owner_ref text not null check (owner_ref <> ''),
  scope text not null check (scope in ('owner', 'project')),
  scope_id text not null check (scope_id <> ''),
  limit_key text not null check (limit_key in (
    'databaseStorageBytes', 'fileStorageBytes', 'bandwidthBytes',
    'backendExecutionMs', 'backendExecutionCalls', 'backgroundJobs',
    'concurrentJobs', 'realtimeConnections', 'providerTokens'
  )),
  -- null is an explicit "unlimited here", which is different from no row.
  limit_value numeric(24, 3) null,
  updated_at timestamptz not null,
  updated_by text not null,
  primary key (owner_ref, scope, scope_id, limit_key)
);

create table if not exists usage_entitlements (
  owner_ref text not null check (owner_ref <> ''),
  plan_id text not null check (plan_id in ('development', 'paid')),
  source text not null check (source in ('default', 'operator')),
  updated_at timestamptz not null,
  updated_by text not null,
  primary key (owner_ref)
);
`,
};
