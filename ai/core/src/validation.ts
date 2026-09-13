import type { AIConfig } from './config/index.js';
import { InvalidAIRequestError } from './errors/index.js';
import {
  isAICapability,
  type AIRequest,
  type AIMessage,
  type AIMessageRole,
} from './types/index.js';

const ROLES: readonly AIMessageRole[] = ['system', 'user', 'assistant'];
const MAX_TEMPERATURE = 2;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates that `value` is a well-formed AIRequest and enforces configured
 * limits. Throws InvalidAIRequestError with the full list of issues, so
 * callers (API layer, future agents) get one clear typed error.
 */
export function validateAIRequest(value: unknown, config: AIConfig): AIRequest {
  const issues: string[] = [];

  if (!isPlainObject(value)) {
    throw new InvalidAIRequestError('Request must be an object');
  }

  const raw = value as Record<string, unknown>;

  // messages
  const messages: AIMessage[] = [];
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    issues.push('messages: must be a non-empty array');
  } else if (raw.messages.length > config.maxInputMessages) {
    issues.push(`messages: at most ${config.maxInputMessages} messages allowed`);
  } else {
    for (const [index, entry] of raw.messages.entries()) {
      if (!isPlainObject(entry)) {
        issues.push(`messages[${index}]: must be an object`);
        continue;
      }
      const { role, content } = entry as Record<string, unknown>;
      if (typeof role !== 'string' || !ROLES.includes(role as AIMessageRole)) {
        issues.push(`messages[${index}].role: must be one of ${ROLES.join(', ')}`);
      }
      if (typeof content !== 'string' || content.length === 0) {
        issues.push(`messages[${index}].content: must be a non-empty string`);
      } else if (content.length > config.maxInputChars) {
        issues.push(`messages[${index}].content: exceeds ${config.maxInputChars} characters`);
      }
      if (typeof role === 'string' && typeof content === 'string' && content.length > 0) {
        messages.push({ role: role as AIMessageRole, content });
      }
    }
  }

  // system
  if (raw.system !== undefined) {
    if (typeof raw.system !== 'string' || raw.system.length === 0) {
      issues.push('system: must be a non-empty string when provided');
    } else if (raw.system.length > config.maxInputChars) {
      issues.push(`system: exceeds ${config.maxInputChars} characters`);
    }
  }

  // model
  if (raw.model !== undefined && (typeof raw.model !== 'string' || raw.model.length === 0)) {
    issues.push('model: must be a non-empty string when provided');
  }

  // capabilities
  let capabilities: readonly string[] | undefined;
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities)) {
      issues.push('capabilities: must be an array when provided');
    } else if (!raw.capabilities.every((cap) => isAICapability(cap))) {
      issues.push('capabilities: contains an unknown capability');
    } else {
      capabilities = raw.capabilities as readonly string[];
    }
  }

  // temperature
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature !== 'number' || Number.isNaN(raw.temperature)) {
      issues.push('temperature: must be a number when provided');
    } else if (raw.temperature < 0 || raw.temperature > MAX_TEMPERATURE) {
      issues.push(`temperature: must be between 0 and ${MAX_TEMPERATURE}`);
    }
  }

  // maxOutputTokens
  if (raw.maxOutputTokens !== undefined) {
    if (
      typeof raw.maxOutputTokens !== 'number' ||
      !Number.isInteger(raw.maxOutputTokens) ||
      raw.maxOutputTokens < 1
    ) {
      issues.push('maxOutputTokens: must be a positive integer when provided');
    }
  }

  // structuredOutput
  if (raw.structuredOutput !== undefined) {
    const spec = raw.structuredOutput;
    if (!isPlainObject(spec)) {
      issues.push('structuredOutput: must be an object when provided');
    } else if (typeof spec.name !== 'string' || spec.name.length === 0) {
      issues.push('structuredOutput.name: must be a non-empty string');
    } else if (spec.schema !== undefined && !isPlainObject(spec.schema)) {
      issues.push('structuredOutput.schema: must be an object when provided');
    }
  }

  if (issues.length > 0) {
    throw new InvalidAIRequestError(`Invalid AI request: ${issues.join('; ')}`, {
      details: { issues },
    });
  }

  const structuredOutput =
    raw.structuredOutput === undefined
      ? undefined
      : {
          name: (raw.structuredOutput as Record<string, unknown>).name as string,
          schema: (raw.structuredOutput as Record<string, unknown>).schema as
            Readonly<Record<string, unknown>> | undefined,
        };

  const request: AIRequest = {
    messages,
    system: raw.system as string | undefined,
    model: raw.model as string | undefined,
    capabilities: capabilities as AIRequest['capabilities'],
    temperature: raw.temperature as number | undefined,
    maxOutputTokens: raw.maxOutputTokens as number | undefined,
    structuredOutput,
  };
  // Omit undefined optionals so `key in request` stays truthful.
  const compact = Object.fromEntries(
    Object.entries(request).filter(([, value]) => value !== undefined),
  ) as unknown as AIRequest;
  return compact;
}
