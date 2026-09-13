import type { ToolInvocationResult } from '@veltravia/tool-core';

/**
 * Agent-level, normalized tool results. The agent never sees raw connector
 * data, internal credentials, or private model reasoning - only the
 * Tool System's normalized output plus safe timestamps.
 */

export const AGENT_TOOL_RESULT_STATUSES = [
  'success',
  'failure',
  'denied',
  'awaiting_confirmation',
] as const;

export type AgentToolResultStatus = (typeof AGENT_TOOL_RESULT_STATUSES)[number];

export interface AgentToolResult {
  /** Tool invocation id (from the Tool System). */
  readonly invocationId: string;
  readonly toolId: string;
  /** Correlation id of the run, when present. */
  readonly correlationId?: string;
  readonly status: AgentToolResultStatus;
  /** Normalized tool output (only on success). Untrusted external data. */
  readonly output?: Readonly<Record<string, unknown>>;
  /** Typed, secret-free error (only on failure/denied). */
  readonly error?: { readonly code: string; readonly message: string };
  readonly requestedAt: string;
  readonly completedAt: string;
  /** Present when status is awaiting_confirmation. */
  readonly confirmationId?: string;
}

/** Maps a Tool System result into the agent-level, normalized shape. */
export function normalizeToolResult(result: ToolInvocationResult): AgentToolResult {
  return {
    invocationId: result.invocationId,
    toolId: result.toolId,
    ...(result.correlationId !== undefined ? { correlationId: result.correlationId } : {}),
    status: result.status,
    ...(result.output !== undefined ? { output: result.output } : {}),
    ...(result.error !== undefined ? { error: { ...result.error } } : {}),
    requestedAt: result.requestedAt,
    completedAt: result.completedAt,
    ...(result.confirmationId !== undefined ? { confirmationId: result.confirmationId } : {}),
  };
}

/** Builds a denied-result shape for outcomes the Tool System paused or rejected (e.g. human rejection). */
export function createDeniedToolResult(input: {
  readonly invocationId: string;
  readonly toolId: string;
  readonly code: string;
  readonly message: string;
  readonly requestedAt: string;
  readonly completedAt: string;
  readonly correlationId?: string;
}): AgentToolResult {
  return {
    invocationId: input.invocationId,
    toolId: input.toolId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    status: 'denied',
    error: { code: input.code, message: input.message },
    requestedAt: input.requestedAt,
    completedAt: input.completedAt,
  };
}
