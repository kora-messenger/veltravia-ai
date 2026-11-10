/**
 * Cached tokens and delegated charges (Step 55).
 *
 * Four facts a charge has to keep, none of which fit the Step 54 columns:
 *
 *  - `measurement_source` says where the token counts came from. A provider
 *    number, a caller's own count, or nothing at all are three different claims
 *    and the dashboard must not print them the same way.
 *  - `cached_savings` records what the cached part saved under the policy in
 *    force at settlement time. The rate table can change, so computing this at
 *    read time would silently rewrite history.
 *  - `task_id` lets an agent run be found by the task it served.
 *  - `parent_charge_id` links a delegated operation to the charge it belongs to,
 *    so a sub-agent's work can be read as part of one billable interaction
 *    instead of looking like an unrelated charge.
 *
 * All four are nullable: existing rows keep their meaning and no backfill invents
 * a source nobody recorded.
 */

export const migration014 = {
  version: '014',
  name: 'message-charge-measurement',
  sql: `
alter table message_charges
  add column if not exists task_id text null,
  add column if not exists parent_charge_id text null,
  add column if not exists cached_savings numeric(18, 4) null
    check (cached_savings is null or cached_savings >= 0),
  add column if not exists measurement_source text null
    check (measurement_source is null or measurement_source in ('provider', 'caller', 'unavailable'));

create index if not exists message_charges_run
  on message_charges (owner_ref, run_id, created_at desc);
create index if not exists message_charges_task
  on message_charges (owner_ref, task_id, created_at desc);
create index if not exists message_charges_parent
  on message_charges (owner_ref, parent_charge_id) where parent_charge_id is not null;
`,
} as const;
