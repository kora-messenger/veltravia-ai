import { randomUUID } from 'node:crypto';
import { scrubDetails } from '@veltravia/connector-core';

/**
 * Integration lifecycle audit events.
 *
 * Extends the platform's audit conventions: immutable, typed,
 * secret-scrubbed records handed to a sink. Every connection lifecycle
 * change, authorization denial, and tool execution is recorded so a
 * future persistent audit pipeline can subscribe without changing the
 * producers.
 */

export const INTEGRATION_AUDIT_EVENT_TYPES = [
  'integration_registered',
  'integration_removed',
  'integration.enabled',
  'integration.disabled',
  'integration.connected',
  'integration.disconnected',
  'integration.authorization_denied',
  'integration.ownership_denied',
  'integration.tool_executed',
  'integration.execution_failed',
  'integration.manifest_rejected',
] as const;

export type IntegrationAuditEventType = (typeof INTEGRATION_AUDIT_EVENT_TYPES)[number];

export function isIntegrationAuditEventType(value: unknown): value is IntegrationAuditEventType {
  return (
    typeof value === 'string' &&
    (INTEGRATION_AUDIT_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** One immutable, secret-free integration audit record. */
export interface IntegrationAuditEvent {
  /** Unique event id (UUID v4). */
  readonly id: string;
  /** What happened. */
  readonly type: IntegrationAuditEventType;
  /** Which integration it happened to ("platform" for system-level events). */
  readonly integrationId: string;
  /** ISO-8601 event time. */
  readonly timestamp: string;
  /** One-line, human-readable, secret-free summary. */
  readonly summary: string;
  /** Optional structured context - scrubbed, never secrets. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type IntegrationAuditSink = (event: IntegrationAuditEvent) => void;

export interface CreateIntegrationAuditEventInput {
  readonly type: IntegrationAuditEventType;
  readonly integrationId: string;
  readonly summary: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp?: string;
  readonly id?: string;
}

/**
 * Creates a validated, scrubbed audit event. The ONLY supported way to
 * produce events - raw construction risks leaking unscrubbed text.
 */
export function createIntegrationAuditEvent(
  input: CreateIntegrationAuditEventInput,
): IntegrationAuditEvent {
  const reasons: string[] = [];
  if (!isIntegrationAuditEventType(input.type)) reasons.push('type is unknown');
  if (typeof input.integrationId !== 'string' || input.integrationId.length === 0) {
    reasons.push('integrationId must be a non-empty string');
  }
  if (typeof input.summary !== 'string' || input.summary.trim().length === 0) {
    reasons.push('summary must be a non-empty string');
  }
  if (reasons.length > 0) {
    throw new Error(`Invalid integration audit event: ${reasons.join('; ')}.`);
  }
  return {
    id: input.id ?? randomUUID(),
    type: input.type,
    integrationId: input.integrationId,
    timestamp: input.timestamp ?? new Date().toISOString(),
    summary: scrubDetails(input.summary) as string,
    ...(input.metadata !== undefined
      ? { metadata: scrubDetails(input.metadata) as Record<string, unknown> }
      : {}),
  };
}
