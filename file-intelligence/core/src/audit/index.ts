import { scrubSecrets } from '../security/index.js';
export const FILE_AUDIT_EVENT_TYPES = [
  'file_uploaded',
  'validation_passed',
  'validation_failed',
  'extraction_requested',
  'extraction_completed',
  'extraction_failed',
  'artifact_created',
  'artifact_downloaded',
  'artifact_deleted',
  'file_deleted',
  'archive_rejected',
  'authorization_denied',
  'integrity_failure',
] as const;
export type FileAuditEventType = (typeof FILE_AUDIT_EVENT_TYPES)[number];
export interface FileAuditEvent {
  readonly type: FileAuditEventType;
  readonly at: string;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly fileId: string | null;
  readonly artifactId: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}
export type FileAuditSink = (event: FileAuditEvent) => void;
export function scrubAuditMetadata(
  input: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(input))
    out[k] = typeof v === 'string' ? scrubSecrets(v).slice(0, 256) : v;
  return out;
}
