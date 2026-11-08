/**
 * End-to-end executions (Step 50).
 *
 * An execution is the record of one natural-language request: the request, its
 * current plan, every plan revision, the approvals it waits on, the ids of the
 * tasks and workers it owns, and the change sets it integrated. The plan and
 * the approval trail are documents because they belong to the core package's
 * vocabulary; the columns are what the API lists and enforces on.
 *
 * The row is owned by `(id, owner_ref)` so another owner's execution cannot be
 * read or continued, and `version` is a compare-and-set so a restarted process
 * cannot overwrite the state another process already advanced.
 */

export const migration009 = {
  version: '009',
  name: 'executions',
  sql: `
create table if not exists executions (
  id text not null,
  owner_ref text not null check (owner_ref <> ''),
  project_id text not null check (project_id <> ''),
  status text not null,
  request_text text not null,
  record jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  primary key (id, owner_ref)
);

create index if not exists executions_owner_project_idx
  on executions (owner_ref, project_id, created_at desc);

create index if not exists executions_owner_status_idx
  on executions (owner_ref, status, created_at desc);
`,
} as const;
