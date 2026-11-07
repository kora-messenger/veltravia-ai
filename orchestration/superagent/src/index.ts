/**
 * @veltravia/superagent-core - real, bounded, model-powered worker execution.
 *
 * A worker is given one assignment and one tool list; a model proposes actions;
 * the server authorises every one of them; the budget, the deadline and the
 * scope are enforced here rather than trusted to the model. Providers come from
 * @veltravia/ai-gateway, which owns the credentials.
 */

export * from './types.js';
export * from './scopes.js';
export * from './governance.js';
export * from './tools.js';
export * from './routing.js';
export * from './prompt.js';
export * from './executor.js';
