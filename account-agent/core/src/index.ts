/**
 * @veltravia/account-agent-core - Step 62.
 *
 * The Personal Account Agent's engine: a closed registry of declared account
 * operations with risk levels, least-privilege permissions, argument validation,
 * single-use confirmations for sensitive actions, idempotency for repeats and an
 * append-only audit trail. Identity always comes from the authenticated session,
 * never from a tool argument.
 */

export * from './types.js';
export * from './validate.js';
export * from './registry.js';
export * from './agent.js';
export * from './memory.js';
