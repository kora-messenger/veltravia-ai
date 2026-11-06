/**
 * Migration 002: version history, run records, exports and GitHub sync.
 *
 * Two shapes are deliberate:
 *  - Version history and sync records are stable domain objects, so they get
 *    their own tables with ownership columns.
 *  - Run records (agent, coding agent, application testing, reasoning) are
 *    audit documents whose field set is still moving. They share one table
 *    keyed by `(kind, id)` with the record body in `jsonb` and only the fields
 *    used for filtering promoted to columns. That is one storage engine, not
 *    four half-implemented ones.
 */

export const migration002 = {
  version: '002',
  name: 'history-runs-exports-sync',
  sql: `
create table if not exists revisions (
  id text primary key,
  project_id text not null,
  workspace_id text not null,
  owner_ref text not null,
  revision_number integer not null,
  payload jsonb not null,
  snapshot jsonb not null,
  created_at timestamptz not null,
  constraint revisions_id_owner_key unique (id, owner_ref),
  constraint revisions_project_owner_fkey
    foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade
);

create index if not exists revisions_workspace_idx
  on revisions (project_id, workspace_id, revision_number desc);

create table if not exists checkpoints (
  id text primary key,
  project_id text not null,
  workspace_id text not null,
  owner_ref text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  constraint checkpoints_project_owner_fkey
    foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade
);

create index if not exists checkpoints_workspace_idx
  on checkpoints (project_id, workspace_id, created_at);

create table if not exists rollback_operations (
  id text primary key,
  project_id text not null,
  workspace_id text not null,
  owner_ref text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  constraint rollback_operations_project_owner_fkey
    foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade
);

create table if not exists branches (
  id text primary key,
  project_id text not null,
  owner_ref text not null,
  workspace_id text null,
  name text not null,
  archived boolean not null default false,
  payload jsonb not null,
  updated_at timestamptz not null,
  constraint branches_id_owner_key unique (id, owner_ref),
  constraint branches_project_owner_fkey
    foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade
);

create index if not exists branches_project_idx on branches (project_id, name);
create index if not exists branches_workspace_idx on branches (workspace_id);

create table if not exists active_branches (
  project_id text not null,
  owner_ref text not null,
  payload jsonb not null,
  updated_at timestamptz not null,
  primary key (project_id, owner_ref),
  constraint active_branches_project_owner_fkey
    foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade
);

create table if not exists run_records (
  kind text not null,
  id text not null,
  owner_ref text not null check (owner_ref <> ''),
  project_id text null,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (kind, id)
);

create index if not exists run_records_owner_idx
  on run_records (owner_ref, kind, created_at desc);
create index if not exists run_records_project_idx
  on run_records (project_id, kind, created_at desc);

create table if not exists export_jobs (
  id text primary key,
  owner_ref text not null check (owner_ref <> ''),
  project_id text not null,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz null
);

create index if not exists export_jobs_owner_idx on export_jobs (owner_ref, created_at desc);
create index if not exists export_jobs_expiry_idx on export_jobs (expires_at);

create table if not exists stored_objects (
  key text primary key,
  owner_ref text not null check (owner_ref <> ''),
  project_id text null,
  content_type text not null,
  bytes bigint not null check (bytes >= 0),
  storage_ref text not null,
  checksum text not null,
  created_at timestamptz not null,
  expires_at timestamptz null
);

create index if not exists stored_objects_owner_idx on stored_objects (owner_ref, created_at desc);
create index if not exists stored_objects_expiry_idx on stored_objects (expires_at);

create table if not exists sync_connections (
  project_id text primary key,
  owner_ref text not null,
  payload jsonb not null,
  updated_at timestamptz not null,
  constraint sync_connections_project_owner_fkey
    foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade
);

create table if not exists sync_plans (
  id text primary key,
  project_id text not null,
  owner_ref text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  constraint sync_plans_project_owner_fkey
    foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade
);

create index if not exists sync_plans_project_idx on sync_plans (project_id, created_at desc);

create table if not exists sync_history (
  id text primary key,
  project_id text not null,
  owner_ref text not null,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  constraint sync_history_project_owner_fkey
    foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade
);

create index if not exists sync_history_project_idx on sync_history (project_id, created_at desc);
`,
} as const;
