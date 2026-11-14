/**
 * @veltravia/subscriptions-core - Step 60.
 *
 * Subscription plans and what they entitle an account to, on top of the billing
 * systems Steps 52-59 already built. It owns no wallet, no ledger, no charge and
 * no price list: it holds the plan catalogue, the subscription on each account,
 * and the rules that decide which plan is actually in force.
 *
 * The moving parts:
 *
 *  - `types`       - the vocabulary: statuses, transitions, the entitlement registry.
 *  - `entitlements`- the single gate: absent is denied, a quantity is a ceiling.
 *  - `plans`       - the shipped catalogue (configurable defaults, not prices).
 *  - `validate`    - plan configuration, refused field by field.
 *  - `lifecycle`   - periods, renewal, plan changes, suspension; pure and clock-free.
 *  - `resolve`     - which plan an account is on, and the words for why.
 *  - `store`       - the port, with compare-and-set and one-record-per-period.
 *  - `memory`      - the in-memory implementation of that port.
 */

export * from './types.js';
export * from './plans.js';
export * from './entitlements.js';
export * from './validate.js';
export * from './lifecycle.js';
export * from './resolve.js';
export * from './store.js';
export * from './memory.js';
