import type { SyncErrorCode } from './types.js';

/**
 * A sync failure with a fixed code. The message is written for a person and is
 * built from fixed text: it never echoes a path from the remote, a response
 * body, a token or file content.
 */
export class SyncError extends Error {
  readonly code: SyncErrorCode;
  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

export function isSyncError(value: unknown): value is SyncError {
  return value instanceof SyncError;
}

/** HTTP status for each code. Missing and foreign both map to 404. */
export function syncHttpStatus(code: SyncErrorCode): number {
  switch (code) {
    case 'SYNC_NOT_FOUND':
    case 'SYNC_NOT_CONNECTED':
    case 'SYNC_REPOSITORY_NOT_ALLOWED':
    case 'SYNC_BRANCH_NOT_FOUND':
      return 404;
    case 'SYNC_INVALID_REQUEST':
      return 400;
    case 'SYNC_ALREADY_CONNECTED':
    case 'SYNC_CONFLICTS_UNRESOLVED':
    case 'SYNC_APPROVAL_REQUIRED':
    case 'SYNC_PLAN_STALE':
    case 'SYNC_PLAN_NOT_ACTIVE':
    case 'SYNC_NOTHING_TO_SYNC':
    case 'SYNC_REMOTE_CHANGED':
    case 'SYNC_CANCELLED':
      return 409;
    case 'SYNC_PLAN_EXPIRED':
      return 410;
    // Well formed, refused on its content: same family as export's 422.
    case 'SYNC_SECRET_REJECTED':
    case 'SYNC_TOO_MANY_CHANGES':
    case 'SYNC_REMOTE_TRUNCATED':
    case 'SYNC_UNSUPPORTED':
      return 422;
    case 'SYNC_GITHUB_FAILED':
      return 502;
    default:
      return 500;
  }
}
