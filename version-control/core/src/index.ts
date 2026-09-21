/**
 * @veltravia/version-core - the Veltravia AI internal Version Control core
 * (Step 18).
 *
 * Immutable revisions, integrity-verified snapshots, named checkpoints, a
 * bounded diff engine, and rollback that ALWAYS creates a new revision.
 * Storage flows through the RevisionStore port (deterministic in-memory
 * mock today); tree state flows only through the VersionWorkspaceGateway
 * port to the Project Engine. File contents are UNTRUSTED PROJECT DATA.
 */

export * from './types/index.js';
export * from './errors/index.js';
export * from './gateway/index.js';
export * from './secrets/index.js';
export * from './integrity/index.js';
export * from './diff/index.js';
export * from './store/index.js';
export * from './retention/index.js';
export * from './audit/index.js';
export * from './manager/index.js';
export * from './tools/index.js';
