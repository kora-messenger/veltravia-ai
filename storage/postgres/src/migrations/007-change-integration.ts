/**
 * Change integration (Step 46).
 *
 * A worker's proposal and the record of what was done with it are separate
 * rows: the change set keeps every file it proposed, the integration keeps the
 * decision that let it into the project and the snapshot that can undo it.
 *
 * `change_artifacts` holds the proposed content, so an integration after a
 * restart applies exactly the bytes the worker produced. Nothing here stores a
 * credential: the validator refuses secret-shaped content before insert.
 *
 * `project_integration_locks` is the cross-process exclusion: one row per
 * project, taken with an expiry so a crashed integration cannot wedge it.
 */

export const migration007 = {
  version: '007',
  name: 'change-integration',
  sql: `
create table if not exists change_sets (
  id text not null,
  owner_ref text not null check (owner_ref <> ''),
  project_id text not null check (project_id <> ''),
  workspace_id text not null check (workspace_id <> ''),
  task_id text null,
  worker_id text null,
  status text not null,
  base_revision integer not null check (base_revision >= 0),
  integration_id text null,
  record jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, owner_ref)
);

create index if not exists change_sets_owner_project
  on change_sets (owner_ref, project_id, created_at desc);

create index if not exists change_sets_owner_worker
  on change_sets (owner_ref, worker_id)
  where worker_id is not null;

create index if not exists change_sets_owner_task
  on change_sets (owner_ref, task_id)
  where task_id is not null;

create table if not exists change_set_files (
  change_set_id text not null,
  owner_ref text not null,
  path text not null,
  op text not null check (op in ('create', 'update', 'delete')),
  base_hash text null,
  proposed_hash text null,
  size integer not null default 0 check (size >= 0),
  artifact_ref text null,
  primary key (change_set_id, owner_ref, path)
);

create table if not exists change_artifacts (
  change_set_id text not null,
  owner_ref text not null,
  path text not null,
  content text not null,
  created_at timestamptz not null default now(),
  primary key (change_set_id, owner_ref, path)
);

create table if not exists integration_approvals (
  id text not null,
  owner_ref text not null check (owner_ref <> ''),
  project_id text not null check (project_id <> ''),
  decision text not null check (decision in ('approve', 'reject')),
  record jsonb not null,
  created_at timestamptz not null default now(),
  primary key (id, owner_ref)
);

create index if not exists integration_approvals_owner_project
  on integration_approvals (owner_ref, project_id, created_at desc);

create table if not exists change_integrations (
  id text not null,
  owner_ref text not null check (owner_ref <> ''),
  project_id text not null check (project_id <> ''),
  workspace_id text not null check (workspace_id <> ''),
  approval_id text not null,
  status text not null,
  base_revision integer null,
  result_revision integer null,
  rollback_snapshot_id text null,
  record jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id, owner_ref)
);

create index if not exists change_integrations_owner_project
  on change_integrations (owner_ref, project_id, created_at desc);

create index if not exists change_integrations_owner_status
  on change_integrations (owner_ref, status, updated_at desc);

-- One integration at a time per project, across processes.
create table if not exists project_integration_locks (
  project_id text not null primary key,
  owner_ref text not null,
  token text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);
`,
};
