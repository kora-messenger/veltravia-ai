/**
 * Superagent recovery (Step 48).
 *
 * A recovery case is the durable answer to "this work failed and here is what
 * we decided": the observation it was opened from, the diagnosis that
 * justified (or refused) repair, the budgets, and the escalation if one was
 * needed. It is stored as a `record` document because the diagnosis and
 * observation vocabularies evolve with the core package, while the columns
 * that the API filters and enforces on are typed.
 *
 * `repair_attempts` is one row per bounded attempt, with the worker it was
 * given to and the verification run that proved (or failed to prove) it. The
 * partial unique index makes "one running attempt per case" a database rule, so
 * a restarted coordinator cannot start a duplicate repair.
 *
 * `recovery_events` is append-only and sequence-numbered per case, written in
 * the same transaction as the state change it describes.
 */

export const migration008 = {
  version: '008',
  name: 'superagent-recovery',
  sql: `
create table if not exists recovery_cases (
  id text not null,
  owner_ref text not null check (owner_ref <> ''),
  project_id text not null check (project_id <> ''),
  task_id text not null check (task_id <> ''),
  worker_id text null,
  status text not null,
  diagnosis_primary text null,
  classification text null,
  attempts integer not null default 0 check (attempts >= 0),
  reassignments integer not null default 0 check (reassignments >= 0),
  record jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  event_seq integer not null default 0,
  primary key (id, owner_ref)
);

create index if not exists recovery_cases_owner_status
  on recovery_cases (owner_ref, status, created_at desc);

create index if not exists recovery_cases_owner_task
  on recovery_cases (owner_ref, task_id, created_at desc);

create index if not exists recovery_cases_owner_project
  on recovery_cases (owner_ref, project_id, created_at desc);

create table if not exists repair_attempts (
  id text not null,
  owner_ref text not null check (owner_ref <> ''),
  case_id text not null,
  attempt integer not null check (attempt >= 1),
  action text not null,
  worker_id text null,
  worker_type text null,
  outcome text not null,
  verification_run_id text null,
  change_set_id text null,
  record jsonb not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz null,
  primary key (id, owner_ref),
  unique (case_id, owner_ref, attempt),
  foreign key (case_id, owner_ref) references recovery_cases (id, owner_ref) on delete cascade
);

create index if not exists repair_attempts_owner_case
  on repair_attempts (owner_ref, case_id, attempt);

-- One running attempt per case, enforced by the schema rather than by hope.
create unique index if not exists repair_attempts_one_running
  on repair_attempts (owner_ref, case_id)
  where outcome = 'running';

create table if not exists recovery_events (
  case_id text not null,
  owner_ref text not null,
  seq integer not null check (seq >= 1),
  type text not null,
  actor text not null,
  message text not null,
  detail jsonb null,
  at timestamptz not null,
  primary key (owner_ref, case_id, seq),
  foreign key (case_id, owner_ref) references recovery_cases (id, owner_ref) on delete cascade
);

create index if not exists recovery_events_owner_case
  on recovery_events (owner_ref, case_id, seq);
`,
} as const;
