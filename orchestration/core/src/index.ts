/**
 * @veltravia/orchestration-core - the Central Primary Agent contract, task
 * identity boundaries, the validated task lifecycle and structured worker
 * assignments.
 *
 * This package deliberately contains no execution: nothing here starts a run,
 * spawns a worker or merges work. It records who is accountable, what was
 * assigned, what state a task is in and what evidence would count as done.
 */

export * from './types.js';
export * from './errors.js';
export * from './secrets.js';
export * from './lifecycle.js';
export * from './contract.js';
export * from './assignment.js';
export * from './store.js';
export * from './tasks.js';
export * from './testing.js';
