import { randomUUID } from 'node:crypto';

import { scrubAgentMetadata, scrubAgentSecrets } from '../errors/index.js';

/**
 * Agent audit events. Concise decision metadata ONLY - never API keys, OAuth
 * tokens, passwords, connector secrets, or hidden chain-of-thought.
 */
export const AGENT_AUDIT_EVENT_TYPES = [
  'agent_run_created',
  'agent_decision_created',
  'agent_tool_requested',
  'agent_waiting_confirmation',
  'agent_tool_result_received',
  'agent_completed',
  'agent_failed',
  'agent_cancelled',
  'agent_limit_reached',
] as const;

export type AgentAuditEventType = (typeof AGENT_AUDIT_EVENT_TYPES)[number];

export function isAgentAuditEventType(value: unknown): value is AgentAuditEventType {
  return (
    typeof value === 'string' && (AGENT_AUDIT_EVENT_TYPES as readonly string[]).includes(value)
  );
}

export interface AgentAuditEvent {
  /** Unique event id (UUID v4). */
  readonly id: string;
  readonly type: AgentAuditEventType;
  /** Agent id. */
  readonly agentId: string;
  /** Run id the event belongs to. */
  readonly runId: string;
  /** Human-readable, secret-free summary. */
  readonly summary: string;
  /** Safe metadata (scrubbed before storage). */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** ISO-8601 timestamp. */
  readonly timestamp: string;
}

export type AgentAuditSink = (event: AgentAuditEvent) => void;

export interface CreateAgentAuditEventInput {
  readonly type: AgentAuditEventType;
  readonly agentId: string;
  readonly runId: string;
  readonly summary: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp?: string;
  readonly id?: string;
}

/** Creates a validated, scrubbed agent audit event. */
export function createAgentAuditEvent(input: CreateAgentAuditEventInput): AgentAuditEvent {
  if (!isAgentAuditEventType(input.type)) {
    throw new Error(`Agent audit event type is unknown: ${String(input.type)}.`);
  }
  if (typeof input.agentId !== 'string' || input.agentId.length === 0) {
    throw new Error('Agent audit event requires a non-empty agentId.');
  }
  if (typeof input.runId !== 'string' || input.runId.length === 0) {
    throw new Error('Agent audit event requires a non-empty runId.');
  }
  if (typeof input.summary !== 'string' || input.summary.trim().length === 0) {
    throw new Error('Agent audit event requires a non-empty summary.');
  }
  const event: AgentAuditEvent = {
    id: input.id ?? randomUUID(),
    type: input.type,
    agentId: input.agentId,
    runId: input.runId,
    summary: scrubAgentSecrets(input.summary),
    ...(input.metadata !== undefined ? { metadata: scrubAgentMetadata(input.metadata) } : {}),
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  return event;
}
