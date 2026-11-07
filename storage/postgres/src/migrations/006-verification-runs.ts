/**
 * Verification runs (Step 45).
 *
 * One row per test execution attempt, keyed `(id, owner_ref)` like every other
 * owner-scoped record, with the whole run stored as JSONB so the evidence a
 * Primary Agent reviews is exactly what was recorded. No credentials are part
 * of a run: output is scrubbed before it reaches this table.
 *
 * `revision` is the project revision the run was pinned to, in the form
 * `<workspaceId>@<workspaceRevision>`, so a result can never be attributed to
 * a later edit.
 */

export const migration006 = {
  version: '006',
  name: 'verification-runs',
  sql: `
create table if not exists verification_runs (
  id text not null,
  owner_ref text not null check (owner_ref <> ''),
  project_id text not null check (project_id <> ''),
  task_id text null,
  worker_id text null,
  revision text null,
  status text not null,
  attempt integer not null default 0 check (attempt >= 0),
  repairs_run_id text null,
  record jsonb not null,
  started_at timestamptz not null,
  finished_at timestamptz null,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, owner_ref)
);

create index if not exists verification_runs_owner_project
  on verification_runs (owner_ref, project_id, started_at desc);

create index if not exists verification_runs_owner_task
  on verification_runs (owner_ref, task_id)
  where task_id is not null;

create index if not exists verification_runs_owner_worker
  on verification_runs (owner_ref, worker_id)
  where worker_id is not null;
`,
};
