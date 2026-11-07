/**
 * @veltravia/worker-core - bounded Superagent workers.
 *
 * A worker has one task, one assignment, one tool list, one time budget and a
 * result the Primary Agent reviews. The scheduler decides what may run at once
 * and records why it refused; the manager runs one worker and cannot complete
 * its own work.
 *
 * Nothing in this package performs the assigned work for real: the executor is a
 * port, and the shipped one is a simulation that says so.
 */

export * from './types.js';
export * from './errors.js';
export * from './lifecycle.js';
export * from './assignment.js';
export * from './resources.js';
export * from './review.js';
export * from './store.js';
export * from './scheduler.js';
export * from './runner.js';
export * from './testing.js';
