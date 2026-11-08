/**
 * Credit wallet (Step 53).
 *
 * Two tables carry the money-shaped state and one carries the holds:
 *
 *  - `wallets` is the running total. It is the only mutable row in the schema,
 *    and it is only ever written by the same transaction that writes the entry
 *    explaining the change, with `version` (from the wallet) as the guard.
 *  - `wallet_entries` is the ledger. Append-only: there is no update or delete
 *    path in the store, and `(owner_ref, idempotency_key)` is unique, so a
 *    retried request finds its own entry instead of charging again.
 *  - `wallet_reservations` is capacity held for work in flight, unique per
 *    `(owner_ref, operation_key)` and settled by a compare-and-set on `state`.
 *
 * The three deltas are stored per entry instead of one signed amount, because a
 * hold moves credit sideways and a commit moves it from held to spent. There is
 * no single SQL check that covers every kind: a grant legitimately adds credit
 * without a counter-entry (and its reversal removes it again), while a hold adds
 * available minus and reserved plus. The invariant that must hold is
 * `available + reserved + spent == sum of the deltas`, which is what
 * `CreditWallet.reconcile` proves against the stored wallet row.
 *
 * `usage_record_ref` is deliberately not a foreign key: a usage record is metered
 * per owner and may be pruned long before the credit history is, and a ledger row
 * must stay readable on its own.
 */

export const migration012 = {
  version: '012',
  name: 'credit-wallet',
  sql: `
create table if not exists wallets (
  id text primary key,
  owner_ref text not null check (owner_ref <> ''),
  scope text not null check (scope in ('user', 'workspace')),
  workspace_id text null,
  unit text not null default 'credits' check (unit in ('credits')),
  available numeric(24, 4) not null default 0,
  reserved numeric(24, 4) not null default 0,
  spent numeric(24, 4) not null default 0,
  allow_negative boolean not null default false,
  negative_floor numeric(24, 4) not null default 0 check (negative_floor >= 0),
  version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope = 'user' and workspace_id is null)
    or (scope = 'workspace' and workspace_id is not null and workspace_id <> '')
  ),
  -- A balance below the floor is a bug, not a policy.
  check (available >= -negative_floor)
);

-- One wallet per owner and scope: a second call opens nothing.
create unique index if not exists wallets_owner_scope_key
  on wallets (owner_ref, scope, coalesce(workspace_id, ''));

create table if not exists wallet_entries (
  seq bigserial,
  id text not null,
  owner_ref text not null check (owner_ref <> ''),
  wallet_id text not null references wallets (id) on delete restrict,
  scope text not null check (scope in ('user', 'workspace')),
  workspace_id text null,
  kind text not null check (kind in (
    'purchase', 'grant', 'promotion', 'usage_deduction',
    'reservation', 'reservation_commit', 'reservation_release',
    'refund', 'adjustment_credit', 'adjustment_debit', 'reversal'
  )),
  amount numeric(24, 4) not null check (amount >= 0),
  unit text not null default 'credits' check (unit in ('credits')),
  available_delta numeric(24, 4) not null,
  reserved_delta numeric(24, 4) not null,
  spent_delta numeric(24, 4) not null,
  balance_after numeric(24, 4) not null,
  reserved_after numeric(24, 4) not null,
  spent_after numeric(24, 4) not null,
  source text not null check (source in ('system', 'usage', 'operator', 'purchase', 'plan', 'migration')),
  actor text not null check (actor <> ''),
  reason text not null check (reason <> ''),
  reference_type text null,
  reference_id text null,
  idempotency_key text not null check (idempotency_key <> ''),
  reverses_entry_id text null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (owner_ref, seq),
  unique (owner_ref, id),
  unique (owner_ref, idempotency_key)
);

create index if not exists wallet_entries_owner_wallet_seq_idx
  on wallet_entries (owner_ref, wallet_id, seq desc);

create index if not exists wallet_entries_reference_idx
  on wallet_entries (owner_ref, reference_type, reference_id);

create table if not exists wallet_reservations (
  id text primary key,
  owner_ref text not null check (owner_ref <> ''),
  wallet_id text not null references wallets (id) on delete restrict,
  amount numeric(24, 4) not null check (amount > 0),
  unit text not null default 'credits' check (unit in ('credits')),
  state text not null check (state in ('held', 'committed', 'released', 'expired')),
  operation_key text not null check (operation_key <> ''),
  reference_type text null,
  reference_id text null,
  committed_amount numeric(24, 4) null,
  expires_at timestamptz not null,
  settled_at timestamptz null,
  created_at timestamptz not null default now(),
  unique (owner_ref, operation_key)
);

create index if not exists wallet_reservations_open_idx
  on wallet_reservations (owner_ref, wallet_id, state);
`,
} as const;
