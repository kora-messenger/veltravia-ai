import { randomUUID } from 'node:crypto';

import type { ConfirmationState } from '../confirmation/index.js';

/**
 * The invocation model: an AI request to use a tool is NOT automatically
 * permission to execute. A ToolInvocation records the request; the
 * ToolInvocationResult records the outcome of the controlled pipeline.
 */

export const TOOL_INVOCATION_STATUSES = [
  'pending',
  'awaiting_confirmation',
  'denied',
  'succeeded',
  'failed',
] as const;

export type ToolInvocationStatus = (typeof TOOL_INVOCATION_STATUSES)[number];

export function isToolInvocationStatus(value: unknown): value is ToolInvocationStatus {
  return (
    typeof value === 'string' && (TOOL_INVOCATION_STATUSES as readonly string[]).includes(value)
  );
}

/** Result statuses: the four documented outcomes. */
export const TOOL_INVOCATION_RESULT_STATUSES = [
  'success',
  'failure',
  'denied',
  'awaiting_confirmation',
] as const;

export type ToolInvocationResultStatus = (typeof TOOL_INVOCATION_RESULT_STATUSES)[number];

/**
 * One AI request to invoke a tool. Pure data: it carries no authority and
 * no secrets - the executor re-checks everything from scratch.
 */
export interface ToolInvocation {
  /** Unique invocation id (UUID v4). */
  readonly id: string;
  /** Which tool was requested. */
  readonly toolId: string;
  /** The (untrusted, pre-validation) input as requested. */
  readonly input: Readonly<Record<string, unknown>>;
  /** ISO-8601 request time. */
  readonly requestedAt: string;
  /** Who/what requested this (e.g. "api", "agent", "test-harness"). */
  readonly requester: string;
  /** Permissions the requester CLAIMED - claims grant nothing. */
  readonly requestedPermissions?: readonly string[];
  /** Current confirmation state of this invocation. */
  readonly confirmationState: ConfirmationState;
  /** Correlates related invocations across a future agent conversation. */
  readonly correlationId?: string;
  /** Confirmation id, once a confirmation was opened. */
  readonly confirmationId?: string;
}

export interface CreateToolInvocationInput {
  readonly toolId: string;
  readonly input: Record<string, unknown>;
  readonly requester: string;
  readonly requestedPermissions?: readonly string[];
  readonly correlationId?: string;
  readonly requestedAt?: string;
  readonly id?: string;
}

/** Creates a validated invocation record. */
export function createToolInvocation(input: CreateToolInvocationInput): ToolInvocation {
  const reasons: string[] = [];
  if (typeof input.toolId !== 'string' || input.toolId.length === 0) {
    reasons.push('toolId must be a non-empty string');
  }
  if (input.input === null || typeof input.input !== 'object' || Array.isArray(input.input)) {
    reasons.push('input must be an object');
  }
  if (typeof input.requester !== 'string' || input.requester.trim().length === 0) {
    reasons.push('requester must be a non-empty string');
  }
  if (reasons.length > 0) {
    throw new Error(`Invalid tool invocation: ${reasons.join('; ')}.`);
  }
  return {
    id: input.id ?? randomUUID(),
    toolId: input.toolId,
    input: { ...input.input },
    requestedAt: input.requestedAt ?? new Date().toISOString(),
    requester: input.requester,
    ...(input.requestedPermissions !== undefined
      ? { requestedPermissions: [...input.requestedPermissions] }
      : {}),
    confirmationState: 'not_required',
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
}

/** Normalized, schema-validating result of one invocation. */
export interface ToolInvocationResult {
  /** The invocation this result belongs to. */
  readonly invocationId: string;
  readonly toolId: string;
  readonly correlationId?: string;
  readonly status: ToolInvocationResultStatus;
  /** The normalized tool output (only on success). */
  readonly output?: Readonly<Record<string, unknown>>;
  /** Typed, secret-free failure reason (never on success). */
  readonly error?: { readonly code: string; readonly message: string };
  /** ISO-8601 request time. */
  readonly requestedAt: string;
  /** ISO-8601 completion time. */
  readonly completedAt: string;
  /** Confirmation id when status is awaiting_confirmation. */
  readonly confirmationId?: string;
}

export interface CreateToolInvocationResultInput {
  readonly invocationId: string;
  readonly toolId: string;
  readonly correlationId?: string;
  readonly status: ToolInvocationResultStatus;
  readonly output?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
  readonly requestedAt: string;
  readonly completedAt: string;
  readonly confirmationId?: string;
}

/** Creates a validated, normalized result record. */
export function createToolInvocationResult(
  input: CreateToolInvocationResultInput,
): ToolInvocationResult {
  const reasons: string[] = [];
  if (typeof input.invocationId !== 'string' || input.invocationId.length === 0) {
    reasons.push('invocationId must be a non-empty string');
  }
  if (!isToolInvocationStatus(input.status) && !isResultStatus(input.status)) {
    reasons.push('status is unknown');
  }
  if (
    input.status === 'success' &&
    (input.output === undefined || typeof input.output !== 'object')
  ) {
    reasons.push('success results must carry an output object');
  }
  if (input.output !== undefined && (input.output === null || typeof input.output !== 'object')) {
    reasons.push('output must be an object');
  }
  if (
    input.error !== undefined &&
    (typeof input.error.code !== 'string' || typeof input.error.message !== 'string')
  ) {
    reasons.push('error must carry a code and a message');
  }
  if (reasons.length > 0) {
    throw new Error(`Invalid tool invocation result: ${reasons.join('; ')}.`);
  }
  return {
    invocationId: input.invocationId,
    toolId: input.toolId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    status: input.status,
    ...(input.output !== undefined ? { output: { ...input.output } } : {}),
    ...(input.error !== undefined ? { error: { ...input.error } } : {}),
    requestedAt: input.requestedAt,
    completedAt: input.completedAt,
    ...(input.confirmationId !== undefined ? { confirmationId: input.confirmationId } : {}),
  };
}

function isResultStatus(value: unknown): value is ToolInvocationResultStatus {
  return (
    typeof value === 'string' &&
    (TOOL_INVOCATION_RESULT_STATUSES as readonly string[]).includes(value)
  );
}
