/**
 * @veltravia/app-builder-core - the native AI App Builder foundation (Step 30).
 *
 * Veltravia describes software in natural language and has AI plan, create,
 * edit, test, preview and (later) deploy it. This package is the language-
 * independent core of that: nothing here assumes JavaScript, one framework, or
 * one runtime.
 *
 * Boundaries worth knowing:
 * - A technology is a REGISTRY ENTRY, not a branch in the builder.
 * - Specifications are validated structurally AND checked against real support
 *   levels; a planned technology stays planned rather than becoming a guess.
 * - The generator is pure. Writing goes through an explicit project port, so a
 *   plan can be reviewed before anything exists.
 * - The builder never executes commands, never touches provider credentials and
 *   never claims a build it did not run.
 */

export * from './types/index.js';
export * from './errors/index.js';
export * from './registry/index.js';
export * from './spec/index.js';
export * from './detect/index.js';
export * from './generate/templates.js';
export * from './generate/index.js';
export * from './ports/index.js';
export * from './manager/index.js';
