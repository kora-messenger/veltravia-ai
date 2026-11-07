/**
 * @veltravia/recovery-core - Step 48 public surface.
 *
 * Failure detection and classification, evidence-backed diagnosis, bounded
 * repair budgets with backoff, repair planning as a strict subset of the failed
 * assignment, verification-gated recovery, and escalation records. Execution,
 * task state, verification and change integration are ports owned by Steps
 * 43-46; nothing here duplicates them.
 */

export * from './types.js';
export * from './errors.js';
export * from './classify.js';
export * from './diagnose.js';
export * from './policy.js';
export * from './repair.js';
export * from './store.js';
export * from './manager.js';
export * from './testing.js';
