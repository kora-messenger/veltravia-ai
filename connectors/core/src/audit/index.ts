import { randomUUID } from 'node:crypto';
import { scrubDetails } from '../errors/index.js';

/**
 * Lightweight, provider-neutral audit-event abstraction.
 *
 * The connector framework records WHAT happened (registrations, lifecycle
 * transitions, permission changes, operation requests) so that a future
 * persistent audit system can store, search, and alert on it. Step 4 only
 * defines the typed event and hands it to a sink callback - persistence,
 * querying, and retention arrive later.
 *
 * FUTURE INTEGRATION (documented, not built): a future audit pipeline will
 * register a sink that appends every event to durable storage (append-only
 * table, with hash chaining for tamper evidence). The event shape below is
 * already what that table will store, so the migration is a sink swap - no
 * event producers change.
 *
 * SECURITY: events must never contain credentials or secret values. The
 * factory scrubs secret-like strings from summaries and metadata.
 */

export const CONNECTOR_AUDIT_EVENT_TYPES = [
  'connector_registered',
  'connector_configured',
  'connector_connected',
  'connector_disconnected',
  'permission_granted',
  'permission_denied',
  'permission_revoked',
  'operation_requested',
  'operation_approved',
  'operation_rejected',
  'operation_completed',
  'operation_failed',
] as const;

export type ConnectorAuditEventType = (typeof CONNECTOR_AUDIT_EVENT_TYPES)[number];

export function isConnectorAuditEventType(value: unknown): value is ConnectorAuditEventType {
  return (
    typeof value === 'string' && (CONNECTOR_AUDIT_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** One immutable, secret-free audit record. */
export interface ConnectorAuditEvent {
  /** Unique event id (UUID v4). */
  readonly id: string;
  /** What happened. */
  readonly type: ConnectorAuditEventType;
  /** Which connector it happened to ("platform" for manager-level events). */
  readonly connectorId: string;
  /** ISO-8601 event time. */
  readonly timestamp: string;
  /** One-line, human-readable, secret-free summary. */
  readonly summary: string;
  /** Optional structured context - scrubbed, never secrets. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Receives every audit event the framework produces. */
export type AuditSink = (event: ConnectorAuditEvent) => void;

export interface CreateAuditEventInput {
  readonly type: ConnectorAuditEventType;
  readonly connectorId: string;
  readonly summary: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp?: string;
  readonly id?: string;
}

/**
 * Creates a validated, scrubbed audit event. This is the ONLY supported way
 * to produce events - raw construction risks leaking unscrubbed text.
 */
export function createAuditEvent(input: CreateAuditEventInput): ConnectorAuditEvent {
  const reasons: string[] = [];
  if (!isConnectorAuditEventType(input.type)) reasons.push('type is unknown');
  if (typeof input.connectorId !== 'string' || input.connectorId.length === 0) {
    reasons.push('connectorId must be a non-empty string');
  }
  if (typeof input.summary !== 'string' || input.summary.trim().length === 0) {
    reasons.push('summary must be a non-empty string');
  }
  if (reasons.length > 0) {
    throw new Error(`Invalid audit event: ${reasons.join('; ')}.`);
  }
  return {
    id: input.id ?? randomUUID(),
    type: input.type,
    connectorId: input.connectorId,
    timestamp: input.timestamp ?? new Date().toISOString(),
    summary: scrubDetails(input.summary) as string,
    ...(input.metadata !== undefined
      ? { metadata: scrubDetails(input.metadata) as Record<string, unknown> }
      : {}),
  };
}
