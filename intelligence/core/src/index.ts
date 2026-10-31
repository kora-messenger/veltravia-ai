/**
 * @veltravia/intelligence-core - Cross-Source Intelligence and Knowledge
 * Synthesis (Step 25).
 *
 * One registry describes every source the owner may read (uploaded documents,
 * connected apps, project files). Search, evidence, relationships, contradiction
 * detection and synthesis all run over that registry under one set of limits.
 *
 * Trust boundary: retrieved content is UNTRUSTED DATA. It is never an
 * instruction, never a permission grant and never a fact until a claim cites it.
 * Reasoning is a replaceable provider and its mode is always disclosed.
 */
export * from './types/index.js';
export * from './errors/index.js';
export * from './security/index.js';
export * from './sources/index.js';
export * from './search/index.js';
export * from './evidence/index.js';
export * from './relationships/index.js';
export * from './contradictions/index.js';
export * from './reasoning/index.js';
export * from './synthesis/index.js';
export * from './jobs/index.js';
export * from './tools/index.js';
