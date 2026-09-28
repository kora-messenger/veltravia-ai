/** Scrubbed audit events for audio intelligence. Mirrors the Step 19 model:
 *  metadata is bounded and scrubbed, and raw audio or transcript content is
 *  NEVER written to the audit trail - only ids, counts, and codes. */
import { scrubAuditMetadata } from '@veltravia/file-intelligence-core';
import type { FileScope } from '@veltravia/file-intelligence-core';

export const AUDIO_AUDIT_EVENT_TYPES = [
  'audio_processing_started',
  'audio_job_completed',
  'audio_job_failed',
  'audio_job_cancelled',
  'audio_authorization_denied',
  'audio_search_performed',
  'audio_query_answered',
  'audio_summary_generated',
  'audio_extraction_generated',
  'audio_translation_generated',
  'audio_artifact_saved',
] as const;
export type AudioAuditEventType = (typeof AUDIO_AUDIT_EVENT_TYPES)[number];

export interface AudioAuditEvent {
  readonly type: AudioAuditEventType;
  readonly at: string;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly fileId: string | null;
  readonly jobId: string | null;
  readonly metadata: Record<string, string | number | boolean | null>;
}
export type AudioAuditSink = (event: AudioAuditEvent) => void;

export function scrubAudioAuditMetadata(
  metadata: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  return scrubAuditMetadata(metadata);
}
export function buildAudioAuditEvent(
  type: AudioAuditEventType,
  at: string,
  scope: FileScope,
  fileId: string | null,
  jobId: string | null,
  metadata: Record<string, string | number | boolean | null> = {},
): AudioAuditEvent {
  return {
    type,
    at,
    ownerRef: scope.ownerRef,
    projectId: scope.projectId,
    workspaceId: scope.workspaceId,
    fileId,
    jobId,
    metadata: scrubAudioAuditMetadata(metadata),
  };
}
