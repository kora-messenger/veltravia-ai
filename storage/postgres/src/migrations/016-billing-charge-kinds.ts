/**
 * Wider charge kinds (Step 57).
 *
 * Step 54 wrote the allowed set of interaction kinds into a check constraint, and
 * Step 56 added a lane without touching it because integration charges live in
 * their own table. Step 57 prices two more operations - a Primary Agent run and a
 * reasoning run - and the constraint refused the row with "The record does not
 * satisfy the schema constraints" from the store, which read like a database
 * problem rather than the pricing change it was.
 *
 * The list is widened here rather than rewritten in place in the historical
 * migration, so an existing deployment keeps its applied versions intact and only
 * gains the two kinds it is missing.
 *
 * Widening only: nothing is removed, and no amount, state or row is touched.
 */

export const migration016 = {
  version: '016',
  name: 'billing-charge-kinds',
  sql: `
alter table message_charges
  drop constraint if exists message_charges_kind_check;

alter table message_charges
  add constraint message_charges_kind_check check (kind in (
    'chat.message', 'chat.assistant', 'coding.run', 'agent.execution',
    'agent.run', 'reasoning.run', 'tool.call', 'background.task'
  ));
`,
} as const;
