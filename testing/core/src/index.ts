/**
 * @veltravia/testing-core - the Veltravia AI Testing & Debugging Agent core.
 *
 * Everything in this package is provider-neutral, typed, bounded, and
 * Tool-System-gated. There is no second execution pathway: commands run via
 * sandbox.execute through the Tool System (forced human confirmation
 * preserved), and code repairs are applied by the existing Coding Agent
 * whose own plan approval IS the human repair approval.
 */

export * from './types/index.js';
export * from './errors/index.js';
export * from './state/index.js';
export * from './audit/index.js';
export * from './policy/index.js';
export * from './detection/index.js';
export * from './diagnostics/index.js';
export * from './debugger/index.js';
export * from './debugger/repair-source.js';
export * from './manager/index.js';
