/**
 * Workspace credit allocation and the account action trail (Step 62).
 *
 * The constraints are the security model again:
 *
 *  - `workspace_credit_pools` is unique per `(owner, workspace, category)`, so a
 *    workspace has one AI-token ceiling and one integration ceiling and there is
 *    nowhere to put a third that the code does not know about.
 *  - `credit_allocations` references that pool by its composite key, so an
 *    allocation cannot exist in a category whose pool was never set.
 *  - A partial unique index allows **one live allocation per target**, while
 *    revoked and expired rows stay for history. Re-allocating a target after a
 *    revoke is therefore possible and cannot create two budgets at once.
 *  - `allocated`, `reserved` and `consumed` are checked by the database as well
 *    as the code: `reserved + consumed <= allocated` and no negative counters.
 *    That makes a bug in the arithmetic a failed transaction rather than a
 *    budget that quietly overspent.
 *  - `credit_allocation_movements` is keyed on `(owner, idempotency_key)` and is
 *    written first inside the transaction, so a retried reservation finds its own
 *    movement instead of taking the credit twice.
 *  - `account_action_audit` has no update path in the store and a unique
 *    `(owner, idempotency_key)`, and `account_approvals` is consumed by a
 *    conditional update, which is what makes a confirmation single-use.
 *
 * No table here holds a card number, a token value or a provider secret; the
 * approval table stores a hash of the confirmation code, never the code.
 */

export const migration020 = {
  version: '020',
  name: 'workspace-credit-allocation-and-account-actions',
  sql: `
create table if not exists workspace_credit_pools (
  owner_ref text not null,
  workspace_id text not null,
  category text not null check (category in ('ai_tokens', 'integration_credits')),
  total numeric(14, 4) not null default 0 check (total >= 0),
  note text not null default '',
  version integer not null default 1 check (version >= 1),
  updated_at timestamptz not null default now(),
  primary key (owner_ref, workspace_id, category)
);

create table if not exists credit_allocations (
  id text primary key,
  owner_ref text not null,
  workspace_id text not null,
  category text not null check (category in ('ai_tokens', 'integration_credits')),
  target_kind text not null check (target_kind in ('member', 'project', 'agent', 'environment')),
  target_ref text not null check (target_ref <> ''),
  allocation_limit numeric(14, 4) check (allocation_limit is null or allocation_limit >= 0),
  allocated numeric(14, 4) not null default 0 check (allocated >= 0),
  reserved numeric(14, 4) not null default 0 check (reserved >= 0),
  consumed numeric(14, 4) not null default 0 check (consumed >= 0),
  priority integer not null default 0,
  policy text not null default 'manual'
    check (policy in ('manual', 'equal', 'project', 'member', 'priority', 'restricted', 'temporary', 'automatic')),
  allowed_operations jsonb not null default '[]'::jsonb,
  state text not null default 'active' check (state in ('active', 'revoked', 'expired')),
  expires_at timestamptz,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint credit_allocations_pool_exists
    foreign key (owner_ref, workspace_id, category)
    references workspace_credit_pools (owner_ref, workspace_id, category)
    on delete cascade,
  constraint credit_allocations_ceiling
    check (allocation_limit is null or allocated <= allocation_limit),
  constraint credit_allocations_no_overspend
    check (reserved + consumed <= allocated)
);

create unique index if not exists credit_allocations_one_live_per_target
  on credit_allocations (owner_ref, workspace_id, category, target_kind, target_ref)
  where state = 'active';

create index if not exists credit_allocations_by_owner
  on credit_allocations (owner_ref, workspace_id, category, state);

create index if not exists credit_allocations_by_target
  on credit_allocations (owner_ref, target_kind, target_ref);

create table if not exists credit_allocation_events (
  seq bigserial primary key,
  id text not null unique,
  owner_ref text not null,
  workspace_id text not null,
  category text not null,
  allocation_id text,
  target_kind text,
  target_ref text,
  kind text not null,
  amount numeric(14, 4) not null default 0,
  allocated_after numeric(14, 4) not null default 0,
  consumed_after numeric(14, 4) not null default 0,
  reserved_after numeric(14, 4) not null default 0,
  operation_key text,
  operation_kind text,
  actor text not null default '',
  reason text not null default '',
  occurred_at timestamptz not null default now()
);

create index if not exists credit_allocation_events_by_owner
  on credit_allocation_events (owner_ref, workspace_id, category, seq desc);

create index if not exists credit_allocation_events_by_allocation
  on credit_allocation_events (allocation_id, seq desc);

create table if not exists credit_allocation_movements (
  owner_ref text not null,
  idempotency_key text not null,
  workspace_id text not null,
  category text not null,
  occurred_at timestamptz not null default now(),
  primary key (owner_ref, idempotency_key)
);

create table if not exists allocation_policies (
  owner_ref text not null,
  workspace_id text not null,
  category text not null check (category in ('ai_tokens', 'integration_credits')),
  default_policy text not null default 'manual'
    check (default_policy in ('manual', 'equal', 'project', 'member', 'priority', 'restricted', 'temporary', 'automatic')),
  auto_limit numeric(14, 4) not null default 0 check (auto_limit >= 0),
  max_target_share_pct integer not null default 100 check (max_target_share_pct between 0 and 100),
  updated_at timestamptz not null default now(),
  primary key (owner_ref, workspace_id, category)
);

create table if not exists account_action_audit (
  id text primary key,
  owner_ref text not null,
  workspace_id text,
  session_id text not null default '',
  role text not null default 'member' check (role in ('member', 'admin', 'owner')),
  tool text not null,
  risk smallint not null check (risk between 1 and 4),
  permission text not null,
  status text not null
    check (status in ('suggested', 'awaiting_confirmation', 'executed', 'failed', 'refused', 'replayed')),
  args_digest text not null,
  args jsonb not null default '{}'::jsonb,
  target jsonb,
  result_summary text,
  changed jsonb not null default '[]'::jsonb,
  failure_code text,
  failure_message text,
  approval_id text,
  execution_id text,
  idempotency_key text not null,
  suspicious_arguments boolean not null default false,
  occurred_at timestamptz not null default now(),
  constraint account_action_audit_one_per_request unique (owner_ref, idempotency_key)
);

create index if not exists account_action_audit_by_owner
  on account_action_audit (owner_ref, occurred_at desc);

create index if not exists account_action_audit_by_tool
  on account_action_audit (owner_ref, tool, occurred_at desc);

create table if not exists account_approvals (
  id text primary key,
  owner_ref text not null,
  workspace_id text,
  session_id text not null default '',
  tool text not null,
  risk smallint not null check (risk between 1 and 4),
  args_digest text not null,
  args jsonb not null default '{}'::jsonb,
  preview text not null default '',
  state text not null default 'pending' check (state in ('pending', 'consumed', 'expired')),
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

create index if not exists account_approvals_by_owner
  on account_approvals (owner_ref, state, expires_at);
`,
} as const;
