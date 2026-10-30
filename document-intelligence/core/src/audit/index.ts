/** Scrubbed, bounded audit events. Audit metadata NEVER contains document
 *  text, tables, cells, OCR output or provider payloads - only counts and
 *  identifiers, so injection-laden document text can never reach the log. */

export interface DocumentAuditEventInput {
  readonly type: string;
  readonly ownerRef: string;
  readonly [key: string]: string | number | null;
}
export interface DocumentAuditEvent extends DocumentAuditEventInput {
  readonly at: string;
}

export interface DocumentAuditSink {
  record(event: DocumentAuditEventInput): void;
}
