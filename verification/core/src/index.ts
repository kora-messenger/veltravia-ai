/**
 * @veltravia/verification-core - Step 45 public surface.
 *
 * Project verification: discovery from configuration, an operation allowlist
 * that refuses anything a project did not declare, structured results with
 * evidence, bounded repair comparison, and a store port. Execution is a port;
 * the API implements it over the Step 8 sandbox.
 */

export * from './types.js';
export * from './discovery.js';
export * from './policy.js';
export * from './parsers.js';
export * from './sanitize.js';
export * from './runner.js';
export * from './compare.js';
export * from './store.js';
