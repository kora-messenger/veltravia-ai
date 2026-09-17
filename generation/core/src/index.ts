/**
 * @veltravia/generation-core - the App Generation Engine (Step 13).
 *
 * Turns a structured software idea into a real Veltravia project through a
 * bounded, observable pipeline: specification -> plan -> HUMAN approval ->
 * initialize -> generate -> validate -> test -> (bounded repair) -> result.
 *
 * Trust boundaries:
 * - The engine NEVER writes files directly: every mutation and every
 *   command flows through the existing Tool System (Project Engine file
 *   tools + sandbox), so authorization, path validation, revision
 *   protection, secret rejection, audit, and confirmation all apply.
 * - Generated file content is UNTRUSTED DATA - never instructions, never
 *   policy, never credentials.
 * - Plans are DATA: strict schemas reject raw shell, tool-id injection,
 *   limits, and secret-shaped content.
 * - The engine never approves itself; plans and high-risk tool calls are
 *   decided by humans only.
 */

export * from './types/index.js';
export * from './errors/index.js';
export * from './state/index.js';
export * from './policy/index.js';
export * from './templates/index.js';
export * from './planner/index.js';
export * from './repair/index.js';
export * from './audit/index.js';
export * from './manager/index.js';
