/**
 * Backend analysis (Step 33).
 *
 * Reads a project's backend from its own files: route declarations, schema
 * models, serverless handlers, environment variable NAMES and the authentication
 * or database libraries a manifest names. It never connects to a database, never
 * executes code, never sees a secret value and never claims a capability the
 * repository does not have.
 */

export * from './types.js';
export * from './redact.js';
export * from './structure.js';
export * from './extract.js';
export * from './report.js';
