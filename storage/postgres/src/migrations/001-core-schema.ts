/**
 * Migration 001: the core relational schema.
 *
 * Ownership rules encoded in the schema itself:
 *  - every mutable table carries `owner_ref`;
 *  - every child row references its parent by `(parent_id, owner_ref)`, so a
 *    row cannot be attached to another owner's project even by direct SQL;
 *  - cascades follow the project, so deleting a project cannot orphan files.
 */

export const migration001 = {
  version: '001',
  name: 'core-schema',
  sql: `
create table if not exists projects (
  id text primary key,
  owner_ref text not null check (owner_ref <> ''),
  name text not null check (name <> ''),
  description text not null default '',
  status text not null,
  project_type text not null,
  version text not null,
  workspace_id text null,
  revision integer not null default 1 check (revision > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint projects_id_owner_key unique (id, owner_ref)
);

create index if not exists projects_owner_created_idx
  on projects (owner_ref, created_at);

create table if not exists workspaces (
  id text primary key,
  project_id text not null,
  owner_ref text not null check (owner_ref <> ''),
  name text not null check (name <> ''),
  root text not null,
  status text not null,
  revision integer not null default 1 check (revision > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint workspaces_id_owner_key unique (id, owner_ref),
  constraint workspaces_project_owner_fkey
    foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade
);

create index if not exists workspaces_project_idx on workspaces (project_id);

create table if not exists file_nodes (
  id text primary key,
  workspace_id text not null,
  owner_ref text not null check (owner_ref <> ''),
  path text not null,
  name text not null,
  type text not null check (type in ('file', 'directory')),
  parent_id text null,
  content text null,
  size integer not null default 0 check (size >= 0),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint file_nodes_workspace_path_key unique (workspace_id, path),
  constraint file_nodes_id_owner_key unique (id, owner_ref),
  constraint file_nodes_workspace_owner_fkey
    foreign key (workspace_id, owner_ref) references workspaces (id, owner_ref) on delete cascade,
  constraint file_nodes_content_shape check (
    (type = 'directory' and content is null and size = 0)
    or (type = 'file')
  )
);

create index if not exists file_nodes_workspace_path_idx on file_nodes (workspace_id, path);
create index if not exists file_nodes_parent_idx on file_nodes (workspace_id, parent_id);

create table if not exists project_contexts (
  project_id text primary key,
  owner_ref text not null,
  payload jsonb not null,
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null,
  constraint project_contexts_project_owner_fkey
    foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade
);

create table if not exists project_configs (
  project_id text primary key,
  owner_ref text not null,
  payload jsonb not null,
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null,
  constraint project_configs_project_owner_fkey
    foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade
);

create table if not exists integration_refs (
  project_id text not null,
  integration_ref text not null,
  owner_ref text not null,
  payload jsonb not null,
  updated_at timestamptz not null,
  primary key (project_id, integration_ref),
  constraint integration_refs_project_owner_fkey
    foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade
);

create table if not exists memories (
  id text primary key,
  project_id text not null,
  owner_ref text not null,
  workspace_id text null,
  type text not null,
  title text not null,
  content text not null,
  status text not null,
  revision integer not null default 1 check (revision > 0),
  payload jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint memories_id_owner_key unique (id, owner_ref),
  constraint memories_project_owner_fkey
    foreign key (project_id, owner_ref) references projects (id, owner_ref) on delete cascade
);

create index if not exists memories_project_idx on memories (project_id, created_at);
create index if not exists memories_status_idx on memories (project_id, status);
`,
} as const;
