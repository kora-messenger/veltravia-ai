/**
 * Reliability primitives (Step 51).
 *
 * Four tables, each one owning a guarantee the API relies on:
 *
 *  - `idempotency_records` makes one key mean one operation. The primary key is
 *    `(owner_ref, scope, key)`, so a key cannot address another owner's record,
 *    and `fingerprint` is what turns a reused key into a refusal rather than a
 *    replay of a different request.
 *  - `execution_leases` is the claim two API instances contend for. The primary
 *    key is the resource, so there is exactly one live claim per resource; the
 *    claim statement is a single `insert ... on conflict do update ... where
 *    expired or released`, which is what makes the contention safe.
 *  - `event_inbox` records a side effect once per `(owner_ref, event_key)`.
 *    `attempts` and `available_at` are the bounded retry, `last_error` is what a
 *    failed delivery said.
 *  - `orchestration_recoveries` records what a sweep decided about an
 *    interrupted execution, with the evidence it decided on, so a restart does
 *    not have to guess what the previous process was doing.
 *
 * Nothing here duplicates a task event, a worker event or a recovery attempt:
 * those engines keep their own history.
 */

export const migration010 = {
  version: '010',
  name: 'reliability',
  sql: `
create table if not exists idempotency_records (
  owner_ref text not null check (owner_ref <> ''),
  scope text not null check (scope <> ''),
  key text not null check (key <> ''),
  fingerprint text not null check (fingerprint <> ''),
  status text not null check (status in ('in_progress', 'completed', 'failed')),
  operation_id text not null,
  response jsonb null,
  failure jsonb null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (owner_ref, scope, key)
);

create index if not exists idempotency_owner_status_idx
  on idempotency_records (owner_ref, status, updated_at desc);

create table if not exists execution_leases (
  owner_ref text not null check (owner_ref <> ''),
  resource text not null check (resource <> ''),
  holder text not null check (holder <> ''),
  acquired_at timestamptz not null,
  renewed_at timestamptz not null,
  expires_at timestamptz not null,
  released_at timestamptz null,
  note text null,
  primary key (owner_ref, resource)
);

create index if not exists execution_leases_expiry_idx
  on execution_leases (owner_ref, expires_at);

create table if not exists event_inbox (
  owner_ref text not null check (owner_ref <> ''),
  event_key text not null check (event_key <> ''),
  topic text not null check (topic <> ''),
  payload jsonb not null default 'null'::jsonb,
  status text not null check (status in ('pending', 'processed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text null,
  received_at timestamptz not null,
  processed_at timestamptz null,
  available_at timestamptz not null,
  primary key (owner_ref, event_key)
);

create index if not exists event_inbox_due_idx
  on event_inbox (owner_ref, status, available_at);

create table if not exists orchestration_recoveries (
  id text not null,
  owner_ref text not null check (owner_ref <> ''),
  execution_id text not null check (execution_id <> ''),
  action text not null check (action in ('resume', 'recover', 'await_owner', 'leave')),
  reason text not null,
  evidence jsonb not null default '[]'::jsonb,
  holder text not null,
  lease_expired boolean not null default false,
  decided_at timestamptz not null,
  primary key (id, owner_ref)
);

create index if not exists orchestration_recoveries_execution_idx
  on orchestration_recoveries (owner_ref, execution_id, decided_at desc);
`,
} as const;
