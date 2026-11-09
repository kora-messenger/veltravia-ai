/**
 * Message credits (Step 54).
 *
 * Two tables:
 *
 *  - `message_charges` is the audit of one billable interaction: who, where,
 *    which model, what was measured, what was charged, and what could not be
 *    measured. `(owner_ref, idempotency_key)` is unique, so a retried request
 *    finds its first row instead of charging again. The state column moves
 *    forward only (reserved -> committed | released | exempt -> refunded); the
 *    rows are never deleted and never rewritten with a different amount.
 *  - `message_credit_settings` is a user's own spending ceiling. An empty
 *    `workspace_id` means the personal wallet.
 *
 * Money stays in `wallet_entries` (Step 53): a committed charge points at the
 * ledger row it produced, and a refund goes through the wallet's refund path, so
 * there is still exactly one place that says what a balance is.
 */

export const migration013 = {
  version: '013',
  name: 'message-credits',
  sql: `
create table if not exists message_charges (
  owner_ref text not null check (owner_ref <> ''),
  id text not null,
  workspace_id text null,
  project_id text null,
  conversation_id text null,
  run_id text null,
  usage_operation_key text null,
  kind text not null check (kind in (
    'chat.message', 'chat.assistant', 'coding.run', 'agent.execution',
    'tool.call', 'background.task'
  )),
  model_id text null,
  provider_id text null,
  byok boolean not null default false,
  input_tokens integer null check (input_tokens is null or input_tokens >= 0),
  output_tokens integer null check (output_tokens is null or output_tokens >= 0),
  cached_tokens integer null check (cached_tokens is null or cached_tokens >= 0),
  duration_ms bigint null check (duration_ms is null or duration_ms >= 0),
  tool_calls integer null check (tool_calls is null or tool_calls >= 0),
  credits numeric(18, 4) not null default 0 check (credits >= 0),
  estimated_credits numeric(18, 4) not null default 0 check (estimated_credits >= 0),
  state text not null check (state in ('reserved', 'committed', 'released', 'exempt', 'refunded')),
  basis text not null check (basis in ('flat', 'usage', 'flat+usage', 'unmeasured', 'exempt')),
  policy_id text not null,
  limitations jsonb not null default '[]'::jsonb,
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

create index if not exists message_charges_recent
  on message_charges (owner_ref, created_at desc);
create index if not exists message_charges_conversation
  on message_charges (owner_ref, conversation_id, created_at desc);
create index if not exists message_charges_open
  on message_charges (owner_ref, state) where state = 'reserved';

create table if not exists message_credit_settings (
  owner_ref text not null check (owner_ref <> ''),
  workspace_id text not null default '',
  monthly_limit numeric(18, 4) null check (monthly_limit is null or monthly_limit >= 0),
  per_request_limit numeric(18, 4) null check (per_request_limit is null or per_request_limit >= 0),
  updated_at timestamptz not null default now(),
  primary key (owner_ref, workspace_id)
);
`,
} as const;
