/** Scrubbed, bounded audit events. Audit metadata NEVER contains video
 *  content, transcript text, OCR text, or provider payloads - only counts
 *  and identifiers, so injection-laden video text can never reach the log. */

export interface VideoAuditEventInput {
  readonly type: string;
  readonly ownerRef: string;
  readonly [key: string]: string | number | null;
}
export interface VideoAuditEvent extends VideoAuditEventInput {
  readonly at: string;
}

export interface VideoAuditSink {
  record(event: VideoAuditEventInput): void;
}
