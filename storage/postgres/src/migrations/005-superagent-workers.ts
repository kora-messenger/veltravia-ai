/**
 * Supervisor worker records (Step 43).
 *
 * Three tables, one aggregate:
 *  - `workers`              one bounded assignment, its lifecycle and its result;
 *  - `worker_events`        append-only, `seq` per worker, so history cannot lie;
 *  - `scheduling_decisions` why the scheduler did or did not start work.
 *
 * Ownership is in the schema, not only in the service: a worker references
 * `(task_id, owner_ref)` to `tasks`, so a worker cannot attach to another
 * owner's task even if a predicate is forgotten. One partial unique index
 * enforces the closed rule that a task has at most one live worker, which is
 * what makes duplicate assignment impossible rather than merely unlikely.
 *
 * Worker attempts are NOT duplicated here: an attempt is the existing
 * `task_attempts` row, opened with `run_id = worker id`.
 */

export const migration005 = {
  version: '005',
  name: 'superagent-workers',
  sql: `
create table if not exists workers (
  id text not null,
  owner_ref text not null check (owner_ref <> ''),
  task_id text not null,
  parent_task_id text null,
  primary_run_id text null,
  worker_type text not null check (worker_type <> ''),
  status text not null,
  assignment jsonb not null,
  result jsonb null,
  review jsonb null,
  failure jsonb null,
  claims jsonb not null default '[]'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  retry_not_before timestamptz null,
  started_at timestamptz null,
  ended_at timestamptz null,
  last_heartbeat_at timestamptz null,
  version integer not null default 1 check (version > 0),
  event_seq integer not null default 0 check (event_seq >= 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (id, owner_ref),
  foreign key (task_id, owner_ref) references tasks (id, owner_ref) on delete cascade
);

create index if not exists workers_owner_status_idx
  on workers (owner_ref, status, created_at desc);
create index if not exists workers_owner_task_idx
  on workers (owner_ref, task_id, created_at desc);
create index if not exists workers_owner_live_idx
  on workers (owner_ref, last_heartbeat_at desc)
  where status in ('starting', 'running');

-- One live worker per task. This is the duplicate-assignment rule, expressed
-- where it cannot be bypassed.
create unique index if not exists workers_one_live_per_task
  on workers (task_id, owner_ref)
  where status in ('queued', 'assigned', 'starting', 'running', 'blocked', 'awaiting_review');

create table if not exists worker_events (
  worker_id text not null,
  owner_ref text not null,
  seq integer not null,
  type text not null,
  actor text not null,
  from_status text null,
  to_status text null,
  message text null,
  detail jsonb null,
  at timestamptz not null,
  primary key (worker_id, owner_ref, seq),
  foreign key (worker_id, owner_ref) references workers (id, owner_ref) on delete cascade
);

create table if not exists scheduling_decisions (
  id text primary key,
  owner_ref text not null check (owner_ref <> ''),
  kind text not null,
  concurrency_limit integer not null check (concurrency_limit > 0),
  active_count integer not null check (active_count >= 0),
  selected jsonb not null default '[]'::jsonb,
  skipped jsonb not null default '[]'::jsonb,
  created_at timestamptz not null
);

create index if not exists scheduling_decisions_owner_idx
  on scheduling_decisions (owner_ref, created_at desc);
`,
};
