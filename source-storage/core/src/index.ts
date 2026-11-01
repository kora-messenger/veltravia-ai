/**
 * Native project source storage (Step 31).
 *
 * Public surface: the content store, the history recorder, the snapshot
 * comparison helpers, and the owner-scoped repository manager. Everything
 * above this package talks to `SourceRepositoryManager` and to ports; nothing
 * reaches a filesystem or a shell.
 */

export * from './types/index.js';
export * from './errors/index.js';
export * from './store/index.js';
export * from './history/index.js';
export * from './snapshot/index.js';
export * from './repository/index.js';
