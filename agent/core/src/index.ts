/**
 * @veltravia/agent-core - the provider-neutral agent orchestration layer of
 * Veltravia AI. Everything agent-related builds on this package: agents
 * reason through tasks via AI Core, request tools through the Tool System,
 * and never bypass a single gate.
 */

// Agent abstraction + request/response + default loop
export {
  DefaultAgent,
  extractDecisionJson,
  ModelDecisionSource,
  recordToolOutcome,
  validateAgentRequest,
} from './agent.js';
export type {
  Agent,
  AgentRequest,
  AgentResponse,
  AgentRunContext,
  AgentRunOutcome,
  AgentResponseStatus,
  DecisionSource,
  DefaultAgentOptions,
  ModelDecisionSourceOptions,
} from './agent.js';

// Audit
export * from './audit/index.js';

// Cancellation
export * from './cancellation/index.js';

// Confirmation integration
export * from './confirmation/index.js';

// Context (trust-tagged)
export * from './context/index.js';

// Decisions
export * from './decisions/index.js';

// Errors
export * from './errors/index.js';

// Instructions
export * from './instructions/index.js';

// Invocation (agent-level tool results)
export * from './invocation/index.js';

// Limits
export * from './limits/index.js';

// Manager
export { AgentManager, type AgentManagerOptions } from './manager/index.js';

// Registry
export * from './registry/index.js';

// State
export * from './state/index.js';
