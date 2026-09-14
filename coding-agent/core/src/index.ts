/**
 * @veltravia/coding-agent-core - the Coding Agent layer of Veltravia AI.
 * A controlled software-engineering agent: explicit state machine, validated
 * plans and actions, every operation through the Tool System (Project Engine
 * file tools + sandbox validation), bounded iteration, human approval,
 * cancellation, scrubbed audit. Provider-neutral: no provider SDKs, no host
 * filesystem, no shells, no credentials.
 */

export * from './types/index.js';
export * from './errors/index.js';
export * from './state/index.js';
export * from './policy/index.js';
export * from './audit/index.js';
export * from './decisions/index.js';
export * from './tools/index.js';
export * from './manager/index.js';
