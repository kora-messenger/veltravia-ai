/**
 * @veltravia/spending-limits-core - Step 59.
 *
 * Credit limits and spending controls on top of the Step 52-58 systems. It owns
 * no ledger, no wallet, no price list and no dashboard: it reads what the
 * existing charge lanes already recorded, compares it with a configurable rule,
 * and returns a decision before billable work is authorised.
 *
 * The four moving parts:
 *
 *  - `policy`: what a limit may say, validated against both fixed ceilings and
 *    any platform maximum an operator has set;
 *  - `periods`: the daily, weekly, monthly and custom windows a limit applies to;
 *  - `evaluate`: the single decision function, pure and clock-free;
 *  - `store`: where policies, warning events and the audit are kept.
 */

export * from './types.js';
export * from './periods.js';
export * from './policy.js';
export * from './evaluate.js';
export * from './store.js';
export * from './memory.js';
