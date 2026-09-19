/**
 * @veltravia/codebase-core - Codebase Intelligence & Deep Code Search (Step 16).
 *
 * A typed, provider-independent ANALYSIS and indexing layer over project
 * workspaces: real TypeScript/JavaScript AST parsing, symbol indexes,
 * import/export graphs, route/component/entry-point detection, bounded
 * evidence-backed search, and feature tracing - all pinned to a workspace
 * revision with explicit stale detection and incremental updates.
 *
 * Trust boundary: source content is UNTRUSTED PROJECT DATA. Nothing the
 * index contains can ever act as an instruction, permission, or
 * confirmation. The package never touches the host filesystem (only the
 * CodebaseSourceProvider port), never mutates project files (that is the
 * Coding Agent's job through the Tool System), never executes code, and
 * never stores secret-shaped values (files are flagged, values scrubbed).
 */

export * from './types/index.js';
export * from './errors/index.js';
export * from './languages/index.js';
export * from './frameworks/index.js';
export * from './entrypoints/index.js';
export * from './secrets/index.js';
export * from './parse/index.js';
export * from './relationships/index.js';
export * from './components/index.js';
export * from './index-state/index.js';
export * from './repositories/index.js';
export * from './search/index.js';
export * from './trace/index.js';
export * from './summary/index.js';
export { CodebaseIntelligenceManager } from './manager/index.js';
export type {
  BuildIndexOptions,
  BuildIndexResult,
  CodebaseIntelligenceManagerOptions,
} from './manager/index.js';
export { createCodebaseTools } from './tools/index.js';
