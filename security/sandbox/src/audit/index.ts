/**
 * Sandbox audit events - immutable, scrubbed, and honest.
 *
 * Same philosophy as the Step 4/Step 5 audit modules: a typed event union,
 * a single validated producer, and a sink callback. Commands ARE recorded
 * (they are allowlisted names - safe), arguments are scrubbed, environment
 * VALUES never appear, output never appears, secrets never appear.
 */

import { randomUUID } from 'node:crypto';
import { scrubSecrets } from '../secrets/index.js';

export const SANDBOX_AUDIT_EVENT_TYPES = [
  'sandbox_created',
  'sandbox_execution_requested',
  'sandbox_execution_started',
  'sandbox_execution_completed',
  'sandbox_execution_failed',
  'sandbox_execution_timed_out',
  'sandbox_execution_terminated',
  'sandbox_execution_cancelled',
  'sandbox_stopped',
  'sandbox_expired',
  'sandbox_destroyed',
  'sandbox_failed',
] as const;

export type SandboxAuditEventType = (typeof SANDBOX_AUDIT_EVENT_TYPES)[number];

export function isSandboxAuditEventType(value: unknown): value is SandboxAuditEventType {
  return typeof value === 'string' && (SANDBOX_AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

/** One immutable, secret-free sandbox audit record. */
export interface SandboxAuditEvent {
  readonly id: string;
  readonly type: SandboxAuditEventType;
  /** ISO-8601 event time. */
  readonly timestamp: string;
  /** One-line, human-readable, secret-free summary. */
  readonly summary: string;
  /** Optional structured context - scrubbed, never secrets, never output. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type SandboxAuditSink = (event: SandboxAuditEvent) => void;

export interface CreateSandboxAuditEventInput {
  readonly type: SandboxAuditEventType;
  readonly summary: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp?: string;
  readonly id?: string;
}

/** Creates a validated, scrubbed audit event - the only supported producer. */
export function createSandboxAuditEvent(input: CreateSandboxAuditEventInput): SandboxAuditEvent {
  const reasons: string[] = [];
  if (!isSandboxAuditEventType(input.type)) reasons.push('type is unknown');
  if (typeof input.summary !== 'string' || input.summary.trim().length === 0) {
    reasons.push('summary must be a non-empty string');
  }
  if (reasons.length > 0) {
    throw new Error(`Invalid sandbox audit event: ${reasons.join('; ')}.`);
  }
  const metadata: Record<string, unknown> = {};
  if (input.metadata !== undefined) {
    for (const [key, value] of Object.entries(input.metadata)) {
      if (typeof value === 'string') {
        metadata[key] = scrubSecrets(value).scrubbed;
      } else if (
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null ||
        value === undefined
      ) {
        metadata[key] = value;
      } else {
        metadata[key] = scrubSecrets(safeStringify(value)).scrubbed;
      }
    }
  }
  return {
    id: input.id ?? randomUUID(),
    type: input.type,
    timestamp: input.timestamp ?? new Date().toISOString(),
    summary: scrubSecrets(input.summary).scrubbed,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable]';
  }
}
