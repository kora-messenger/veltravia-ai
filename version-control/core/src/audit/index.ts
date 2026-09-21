/**
 * Version Control audit events (Step 18).
 *
 * Events carry metadata ONLY: ids, revision numbers, counts, and states.
 * File contents and secret-shaped values never enter audit records. The
 * scrubber is applied to every event defensively.
 */

import { containsSecretShapedContent } from '../secrets/index.js';

export const VERSION_AUDIT_EVENT_TYPES = [
  'revision_created',
  'revision_listed',
  'revision_compared',
  'revision_retention_deleted',
  'checkpoint_created',
  'checkpoint_deleted',
  'checkpoint_restored',
  'rollback_requested',
  'rollback_confirmed',
  'rollback_rejected',
  'rollback_started',
  'rollback_completed',
  'rollback_failed',
  'revision_conflict',
  'integrity_failure',
] as const;

export type VersionAuditEventType = (typeof VERSION_AUDIT_EVENT_TYPES)[number];

export interface VersionAuditEvent {
  readonly type: VersionAuditEventType;
  readonly at: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export type VersionAuditSink = (event: VersionAuditEvent) => void;

/** Strips secret-shaped string values from metadata. Field names survive. */
export function scrubMetadata(
  metadata: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' && containsSecretShapedContent(value)) {
      clean[key] = '[redacted]';
    } else {
      clean[key] = value;
    }
  }
  return clean;
}
