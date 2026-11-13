/**
 * Spending limits (Step 59).
 *
 * Four tables, and none of them is a ledger:
 *
 *  - `spending_limit_policies` holds one row per scope. The primary key includes
 *    the workspace and project ids so a personal policy and a workspace policy
 *    (and a project policy under either) cannot overwrite each other, and the
 *    two check constraints refuse a row that claims a scope it does not name.
 *    `version` is the compare-and-set token: a write with a stale version is
 *    refused rather than merged, so two people editing at once cannot silently
 *    produce a policy neither of them set.
 *  - `spending_limit_platform` is the single platform row. It can narrow what a
 *    user may set (a maximum) and supply defaults, but it is never a second copy
 *    of somebody's limit.
 *  - `spending_limit_events` is what actually happened: a threshold crossed, a
 *    limit reached, an operation refused, a policy changed. `(owner_ref,
 *    dedupe_key)` is unique, which is what makes a threshold fire once per
 *    window even when many requests cross it at the same moment.
 *  - `spending_limit_audit` is the who-changed-what record, with the previous
 *    value, the new value and the reason kept as JSON beside the actor.
 *
 * Spending itself is not stored here. It is read from `message_charges`,
 * `integration_charges` and the Step 52 usage records, so a limit and the usage
 * page can never disagree about what was spent.
 */

export const migration017 = {
  version: '017',
  name: 'spending-limits',
  sql: `
create table if not exists spending_limit_policies (
  owner_ref text not null check (owner_ref <> ''),
  scope text not null check (scope in ('user', 'workspace', 'project')),
  workspace_id text not null default '',
  project_id text not null default '',
  rules jsonb not null default '[]'::jsonb,
  per_operation_limit numeric(18, 4) null
    check (per_operation_limit is null or per_operation_limit >= 0),
  max_reserved_credits numeric(18, 4) null
    check (max_reserved_credits is null or max_reserved_credits >= 0),
  version integer not null default 1 check (version >= 1),
  updated_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_ref, scope, workspace_id, project_id),
  constraint spending_limit_policies_workspace_scope
    check ((scope = 'workspace') = (workspace_id <> '')),
  constraint spending_limit_policies_project_scope
    check ((scope = 'project') = (project_id <> ''))
);

create index if not exists spending_limit_policies_owner
  on spending_limit_policies (owner_ref);

create table if not exists spending_limit_platform (
  id text primary key check (id = 'platform'),
  policy jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists spending_limit_events (
  owner_ref text not null check (owner_ref <> ''),
  id text not null,
  kind text not null check (kind in (
    'warning', 'limit-reached', 'operation-refused',
    'policy-changed', 'limit-raised', 'limit-lowered', 'policy-reset'
  )),
  scope text not null check (scope in ('user', 'workspace', 'project')),
  workspace_id text null,
  project_id text null,
  rule_id text null,
  window_key text null,
  threshold numeric(6, 4) null check (threshold is null or (threshold > 0 and threshold < 1)),
  credit_limit numeric(18, 4) null check (credit_limit is null or credit_limit >= 0),
  consumed numeric(18, 4) null check (consumed is null or consumed >= 0),
  requested numeric(18, 4) null check (requested is null or requested >= 0),
  message text not null,
  dedupe_key text not null check (dedupe_key <> ''),
  actor text not null default '',
  occurred_at timestamptz not null,
  primary key (owner_ref, id),
  unique (owner_ref, dedupe_key)
);

create index if not exists spending_limit_events_recent
  on spending_limit_events (owner_ref, occurred_at desc);

create table if not exists spending_limit_audit (
  owner_ref text not null check (owner_ref <> ''),
  id text not null,
  scope text not null check (scope in ('user', 'workspace', 'project')),
  workspace_id text null,
  project_id text null,
  action text not null check (action in ('created', 'updated', 'reset', 'platform-updated')),
  actor text not null default '',
  reason text not null default '',
  previous_state jsonb null,
  next_state jsonb null,
  occurred_at timestamptz not null,
  primary key (owner_ref, id)
);

create index if not exists spending_limit_audit_recent
  on spending_limit_audit (owner_ref, occurred_at desc);
`,
} as const;
