/**
 * Task orchestration records (Step 42).
 *
 * Four tables, one aggregate:
 *  - `tasks`             the unit of work, its owner, scope and lifecycle state;
 *  - `task_dependencies` what must happen before what, as a real edge table so a
 *                        dependency cannot name a task that does not exist;
 *  - `task_events`       append-only history: every status change, assignment,
 *                        review, retry and progress note, in sequence;
 *  - `task_attempts`     one row per execution attempt, with its run id.
 *
 * Ownership is a composite key everywhere: `(id, owner_ref)` on `tasks`, and
 * every child carries `owner_ref` and references its parent by both columns.
 * A task therefore cannot reference another owner's project, and a dependency
 * cannot cross owners even if a service forgets a predicate.
 *
 * `version` is an optimistic-concurrency counter. A transition writes
 * `version + 1` and the event rows in the SAME transaction, and refuses to
 * apply if the stored version moved, so history cannot disagree with state.
 *
 * No column here holds a provider credential, hidden reasoning or a chat
 * transcript: assignments, results and events are bounded summaries.
 */

export const migration004 = {
  version: '004',
  name: 'task-orchestration',
  sql: `
create table if not exists tasks (
  id text not null,
  owner_ref text not null check (owner_ref <> ''),
  project_id text null,
  workspace_id text null,
  chat_id text null,
  parent_task_id text null,
  title text not null check (title <> ''),
  objective text not null check (objective <> ''),
  status text not null check (status in (
    'queued','planning','assigned','running','blocked',
    'partially_completed','awaiting_review','completed','failed','cancelled'
  )),
  review_status text null check (review_status in ('pending','accepted','rejected')),
  assignment jsonb null,
  result jsonb null,
  failure jsonb null,
  retry jsonb not null default '{}'::jsonb,
  checkpoint jsonb null,
  created_by text not null default 'primary_agent' check (created_by in ('primary_agent','owner')),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz null,
  cancelled_at timestamptz null,
  primary key (id, owner_ref),
  foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade,
  foreign key (parent_task_id, owner_ref) references tasks (id, owner_ref)
);

create index if not exists tasks_owner_status_idx
  on tasks (owner_ref, status, created_at desc);
create index if not exists tasks_owner_project_idx
  on tasks (owner_ref, project_id, created_at desc);
create index if not exists tasks_owner_chat_idx
  on tasks (owner_ref, chat_id, created_at desc);
create index if not exists tasks_parent_idx
  on tasks (owner_ref, parent_task_id);

create table if not exists task_dependencies (
  task_id text not null,
  owner_ref text not null,
  depends_on_task_id text not null,
  required boolean not null default true,
  created_at timestamptz not null,
  primary key (task_id, owner_ref, depends_on_task_id),
  foreign key (task_id, owner_ref) references tasks (id, owner_ref) on delete cascade,
  foreign key (depends_on_task_id, owner_ref) references tasks (id, owner_ref) on delete cascade,
  check (task_id <> depends_on_task_id)
);

create index if not exists task_dependencies_target_idx
  on task_dependencies (owner_ref, depends_on_task_id);

create table if not exists task_events (
  task_id text not null,
  owner_ref text not null,
  seq integer not null check (seq >= 1),
  type text not null,
  actor text not null,
  from_status text null,
  to_status text null,
  message text null,
  detail jsonb null,
  at timestamptz not null,
  primary key (task_id, owner_ref, seq),
  foreign key (task_id, owner_ref) references tasks (id, owner_ref) on delete cascade
);

create index if not exists task_events_owner_time_idx
  on task_events (owner_ref, at desc);

create table if not exists task_attempts (
  task_id text not null,
  owner_ref text not null,
  attempt integer not null check (attempt >= 1),
  run_id text null,
  worker text not null,
  status text not null check (status in ('running','completed','failed','cancelled')),
  started_at timestamptz not null,
  ended_at timestamptz null,
  summary text null,
  failure jsonb null,
  primary key (task_id, owner_ref, attempt),
  foreign key (task_id, owner_ref) references tasks (id, owner_ref) on delete cascade
);

create index if not exists task_attempts_run_idx
  on task_attempts (owner_ref, run_id);
`,
} as const;
