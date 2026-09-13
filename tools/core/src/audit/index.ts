import { randomUUID } from 'node:crypto';
import { scrubDetails } from '@veltravia/connector-core';

/**
 * Tool audit events - same shape, scrubbing, and sink philosophy as the
 * Step 4 connector audit events, with tool-specific event types.
 *
 * The connector event union in @veltravia/connector-core is intentionally
 * closed (connector-scoped), so the tool system defines its own typed
 * events here; a single app can wire one sink per framework. Every event is
 * scrubbed: raw inputs, outputs, credentials, and secrets NEVER appear.
 * Persistence (append-only storage, search, alerting) arrives later - a
 * future audit pipeline swaps the sink, and no producer changes.
 */

export const TOOL_AUDIT_EVENT_TYPES = [
  'tool_registered',
  'tool_unregistered',
  'tool_permission_granted',
  'tool_permission_revoked',
  'tool_invocation_requested',
  'tool_invocation_denied',
  'tool_confirmation_requested',
  'tool_confirmation_approved',
  'tool_confirmation_rejected',
  'tool_execution_started',
  'tool_execution_completed',
  'tool_execution_failed',
] as const;

export type ToolAuditEventType = (typeof TOOL_AUDIT_EVENT_TYPES)[number];

export function isToolAuditEventType(value: unknown): value is ToolAuditEventType {
  return typeof value === 'string' && (TOOL_AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

/** One immutable, secret-free tool audit record. */
export interface ToolAuditEvent {
  /** Unique event id (UUID v4). */
  readonly id: string;
  /** What happened. */
  readonly type: ToolAuditEventType;
  /** Which tool it happened to ("tool-system" for framework-level events). */
  readonly toolId: string;
  /** ISO-8601 event time. */
  readonly timestamp: string;
  /** One-line, human-readable, secret-free summary. */
  readonly summary: string;
  /** Optional structured context - scrubbed, never secrets, never raw input. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Receives every tool audit event the framework produces. */
export type ToolAuditSink = (event: ToolAuditEvent) => void;

export interface CreateToolAuditEventInput {
  readonly type: ToolAuditEventType;
  readonly toolId: string;
  readonly summary: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp?: string;
  readonly id?: string;
}

/** Creates a validated, scrubbed audit event - the only supported producer. */
export function createToolAuditEvent(input: CreateToolAuditEventInput): ToolAuditEvent {
  const reasons: string[] = [];
  if (!isToolAuditEventType(input.type)) reasons.push('type is unknown');
  if (typeof input.toolId !== 'string' || input.toolId.length === 0) {
    reasons.push('toolId must be a non-empty string');
  }
  if (typeof input.summary !== 'string' || input.summary.trim().length === 0) {
    reasons.push('summary must be a non-empty string');
  }
  if (reasons.length > 0) {
    throw new Error(`Invalid tool audit event: ${reasons.join('; ')}.`);
  }
  return {
    id: input.id ?? randomUUID(),
    type: input.type,
    toolId: input.toolId,
    timestamp: input.timestamp ?? new Date().toISOString(),
    summary: scrubDetails(input.summary) as string,
    ...(input.metadata !== undefined
      ? { metadata: scrubDetails(input.metadata) as Record<string, unknown> }
      : {}),
  };
}
