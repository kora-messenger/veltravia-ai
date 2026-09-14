/**
 * GitHub Connector audit events. Security-relevant, scrubbed, never carrying
 * credentials, raw headers, or entire file contents. Operations are recorded
 * by identity (owner/repository/path/branch) and outcome - the WHAT, not the
 * payload.
 */

import { scrubGitHubSecrets } from './errors.js';

export const GITHUB_AUDIT_EVENT_TYPES = [
  'github_connection_created',
  'github_connection_authorized',
  'github_authorization_failed',
  'github_operation_requested',
  'github_operation_completed',
  'github_operation_failed',
  'github_scope_denied',
  'github_read',
  'github_branch_created',
  'github_file_created',
  'github_file_updated',
  'github_file_deleted',
  'github_commit_created',
] as const;

export type GitHubAuditEventType = (typeof GITHUB_AUDIT_EVENT_TYPES)[number];

export interface GitHubAuditEvent {
  readonly type: GitHubAuditEventType;
  readonly connectionId: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

export type GitHubAuditSink = (event: GitHubAuditEvent) => void;

/** Builds a sink-safe audit emitter bound to one connection and clock. */
export function createGitHubAuditEmitter(
  connectionId: string,
  now: () => Date,
  sink?: GitHubAuditSink,
): (type: GitHubAuditEventType, message: string, details?: Record<string, unknown>) => void {
  return (type, message, details = {}) => {
    if (sink === undefined) return;
    sink({
      type,
      connectionId,
      message: scrubGitHubSecrets(message),
      details: JSON.parse(scrubGitHubSecrets(JSON.stringify(details))) as Record<string, unknown>,
      timestamp: now().toISOString(),
    });
  };
}
