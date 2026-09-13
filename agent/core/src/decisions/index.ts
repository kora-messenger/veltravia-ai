import { randomUUID } from 'node:crypto';

import { InvalidAgentDecisionError } from '../errors/index.js';
import type { AgentStatus } from '../state/index.js';

/**
 * The provider-neutral decision model. A decision is the ONLY way model
 * reasoning may influence the agent loop, and it carries NO hidden
 * chain-of-thought - just the structured action plus an optional concise
 * summary. Raw model text is never executed on its own.
 */

export const AGENT_DECISION_TYPES = [
  'answer',
  'request_tool',
  'request_confirmation',
  'continue',
  'fail',
  'stop',
] as const;

export type AgentDecisionType = (typeof AGENT_DECISION_TYPES)[number];

export function isAgentDecisionType(value: unknown): value is AgentDecisionType {
  return typeof value === 'string' && (AGENT_DECISION_TYPES as readonly string[]).includes(value);
}

/** Concise summaries are capped - they are not chain-of-thought dumps. */
export const MAX_DECISION_SUMMARY_LENGTH = 500;

/** Each decision type carries exactly the structured payload the loop needs. */
export type AgentDecision =
  | { readonly type: 'answer'; readonly output: string }
  | {
      readonly type: 'request_tool';
      readonly toolId: string;
      readonly input: Record<string, unknown>;
      /** Concise, human-readable reason (never hidden reasoning). */
      readonly summary?: string;
    }
  | {
      readonly type: 'request_confirmation';
      readonly summary?: string;
    }
  | { readonly type: 'continue'; readonly summary?: string }
  | { readonly type: 'fail'; readonly message: string }
  | { readonly type: 'stop'; readonly summary?: string };

export interface ParsedAgentDecision {
  readonly decision: AgentDecision;
  /** The run status the loop should move toward for this decision. */
  readonly targetStatus: AgentStatus;
}

const DECISION_TARGET_STATUS: Record<AgentDecisionType, AgentStatus> = {
  answer: 'completed',
  request_tool: 'waiting_for_tool',
  request_confirmation: 'waiting_for_confirmation',
  continue: 'planning',
  fail: 'failed',
  stop: 'completed',
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readSummary(source: Record<string, unknown>): string | undefined {
  if (source.summary === undefined) return undefined;
  if (typeof source.summary !== 'string') return undefined;
  const trimmed = source.summary.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, MAX_DECISION_SUMMARY_LENGTH);
}

/**
 * Parses and structurally validates a raw (untrusted, model-generated)
 * decision object. NEVER trusts raw AI output: every field is checked, and
 * malformed decisions raise a typed error instead of being acted upon.
 */
export function parseAgentDecision(raw: unknown): ParsedAgentDecision {
  const reasons: string[] = [];
  const record = asRecord(raw);
  if (record === undefined) {
    throw new InvalidAgentDecisionError(['decision must be a JSON object']);
  }
  const type = record.type;
  if (!isAgentDecisionType(type)) {
    reasons.push(
      'type must be one of answer, request_tool, request_confirmation, continue, fail, stop',
    );
    throw new InvalidAgentDecisionError(reasons);
  }

  if (type === 'answer') {
    const output = typeof record.output === 'string' ? record.output.trim() : '';
    if (output.length === 0 || output.length > 20_000) {
      if (output.length === 0) {
        reasons.push('answer decisions require a non-empty output string');
      } else {
        reasons.push('answer output exceeds the maximum length');
      }
      throw new InvalidAgentDecisionError(reasons);
    }
    return { decision: { type, output }, targetStatus: 'completed' };
  }

  if (type === 'request_tool') {
    const toolId =
      typeof record.toolId === 'string' && record.toolId.trim().length > 0
        ? record.toolId.trim()
        : undefined;
    const input = asRecord(record.input);
    const summary = readSummary(record);
    if (toolId === undefined || input === undefined) {
      if (toolId === undefined) {
        reasons.push('request_tool decisions require a non-empty toolId');
      }
      if (input === undefined) {
        reasons.push('request_tool decisions require an input object');
      }
      throw new InvalidAgentDecisionError(reasons);
    }
    return {
      decision: { type, toolId, input, ...(summary !== undefined ? { summary } : {}) },
      targetStatus: 'waiting_for_tool',
    };
  }

  if (type === 'fail') {
    const message =
      typeof record.message === 'string' && record.message.trim().length > 0
        ? record.message.trim()
        : undefined;
    if (message === undefined) {
      reasons.push('fail decisions require a non-empty message string');
      throw new InvalidAgentDecisionError(reasons);
    }
    return { decision: { type, message }, targetStatus: 'failed' };
  }

  // continue | request_confirmation | stop
  const summary = readSummary(record);
  return {
    decision: { type, ...(summary !== undefined ? { summary } : {}) },
    targetStatus: DECISION_TARGET_STATUS[type],
  };
}

/** Agent-level tool request - pure data; the Tool System stays the authority. */
export interface AgentToolRequest {
  /** Unique request id (UUID v4). */
  readonly id: string;
  readonly toolId: string;
  /** The input AS REQUESTED (untrusted model output - Tool System re-validates). */
  readonly input: Readonly<Record<string, unknown>>;
  /** The tool invocation id assigned by the Tool System. */
  readonly invocationId: string;
  /** Concise reason/summary (never hidden chain-of-thought). */
  readonly summary?: string;
  /** Whether the tool requires human confirmation (metadata from Tool System). */
  readonly confirmationRequired: boolean;
  /** Correlates related requests across one run. */
  readonly correlationId: string;
}

export function createAgentToolRequest(input: {
  readonly toolId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly invocationId: string;
  readonly correlationId: string;
  readonly confirmationRequired: boolean;
  readonly summary?: string;
}): AgentToolRequest {
  return {
    id: randomUUID(),
    toolId: input.toolId,
    input: { ...input.input },
    invocationId: input.invocationId,
    correlationId: input.correlationId,
    confirmationRequired: input.confirmationRequired,
    ...(input.summary !== undefined && input.summary.length > 0 ? { summary: input.summary } : {}),
  };
}
