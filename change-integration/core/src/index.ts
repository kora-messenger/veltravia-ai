/**
 * Veltravia change integration (Step 46).
 *
 * A worker proposes; the Primary Agent approves; this package applies, records
 * and can undo. It writes only through `IntegrationTreePort`, so the project
 * engine and source storage stay the single place source lives.
 */

export * from './types.js';
export * from './errors.js';
export * from './hash.js';
export * from './paths.js';
export * from './secrets.js';
export * from './validation.js';
export * from './conflicts.js';
export * from './manager.js';
export * from './memory.js';
