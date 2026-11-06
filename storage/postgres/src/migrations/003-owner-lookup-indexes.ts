/**
 * Migration 003: owner-scoped read paths.
 *
 * Step 41 phase 2 fills a per-owner mirror at the start of a request, which
 * means three reads that nothing was indexed for: this owner's sync
 * connections, this owner's plans, and this owner's history for one project.
 * Without them those loads scan whole tables, and every request pays for it.
 *
 * Indexes only - no table changes - so this migration is a pure additive step
 * that can run against a database already in production.
 */
export const migration003 = {
  version: '003',
  name: 'owner-lookup-indexes',
  sql: `
create index if not exists sync_connections_owner_idx
  on sync_connections (owner_ref);

create index if not exists sync_plans_owner_idx
  on sync_plans (owner_ref, created_at desc);

create index if not exists sync_history_owner_project_idx
  on sync_history (owner_ref, project_id, created_at desc);

-- The export mirror loads by owner; the existing index sorts by created_at
-- only, which the planner cannot use for an owner lookup on its own.
create index if not exists export_jobs_owner_project_idx
  on export_jobs (owner_ref, project_id, created_at desc);

-- Stored runs are read by kind for one owner, newest first.
create index if not exists run_records_owner_kind_idx
  on run_records (owner_ref, kind, updated_at desc);
`,
} as const;
