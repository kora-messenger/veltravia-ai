/** Scrubbed, bounded audit events. Audit metadata NEVER contains image
 *  content, OCR text, descriptions, or provider payloads - only counts and
 *  identifiers, so injection-laden image text can never reach the log. */

export interface ImageAuditEventInput {
  readonly type: string;
  readonly ownerRef: string;
  readonly [key: string]: string | number | null;
}
export interface ImageAuditEvent extends ImageAuditEventInput {
  readonly at: string;
}

export interface ImageAuditSink {
  record(event: ImageAuditEventInput): void;
}
