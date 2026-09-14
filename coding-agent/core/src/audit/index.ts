/**
 * Coding Agent audit events. Security-relevant, scrubbed, no chain-of-thought,
 * no credentials, no unnecessary project content. Tool ids, command NAMES and
 * counts are recorded - never environment values, outputs, or secret material.
 */

import { scrubCodingSecrets } from '../errors/index.js';

export const CODING_AUDIT_EVENT_TYPES = [
  'coding_run_started',
  'coding_plan_created',
  'coding_plan_approved',
  'coding_plan_rejected',
  'coding_tool_requested',
  'coding_tool_executed',
  'coding_tool_denied',
  'coding_confirmation_requested',
  'coding_validation_started',
  'coding_validation_completed',
  'coding_iteration_started',
  'coding_run_completed',
  'coding_run_failed',
  'coding_run_cancelled',
] as const;

export type CodingAuditEventType = (typeof CODING_AUDIT_EVENT_TYPES)[number];

export interface CodingAuditEvent {
  readonly type: CodingAuditEventType;
  readonly runId: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

export type CodingAuditSink = (event: CodingAuditEvent) => void;

/** Builds a sink-safe audit emitter bound to a run and clock. */
export function createCodingAuditEmitter(
  runId: string,
  now: () => Date,
  sink?: CodingAuditSink,
): (type: CodingAuditEventType, message: string, details?: Record<string, unknown>) => void {
  return (type, message, details = {}) => {
    if (sink === undefined) return;
    sink({
      type,
      runId,
      message: scrubCodingSecrets(message),
      details: JSON.parse(scrubCodingSecrets(JSON.stringify(details))) as Record<string, unknown>,
      timestamp: now().toISOString(),
    });
  };
}
