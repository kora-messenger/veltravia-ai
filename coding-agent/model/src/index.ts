/**
 * Model-powered coding agent (Step 35).
 *
 * Provider-neutral: a completion port in, validated coding decisions out. The
 * production port is implemented on the existing AI provider gateway, so
 * credentials, routing, usage and cancellation stay where they already live.
 */

export type {
  CodingModelClient,
  CodingModelClientResult,
  CodingModelMessage,
  CodingModelReply,
  CodingModelRequest,
} from './client.js';
export { ModelCodingError, scrubModelText, type ModelCodingErrorCode } from './errors.js';
export { parseModelDecision, extractJsonObject, normaliseDecisionShape } from './parse.js';
export {
  buildDecisionPrompt,
  DEFAULT_PROMPT_LIMITS,
  SYSTEM_PROMPT,
  type BuiltPrompt,
  type PromptLimits,
} from './prompt.js';
export {
  createModelCodingDecisionSource,
  type ModelCodingOptions,
  type ModelCodingSource,
  type ModelExchange,
} from './source.js';
