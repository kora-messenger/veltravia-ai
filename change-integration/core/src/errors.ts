/**
 * Integration failures, as typed errors the API can map to a status.
 *
 * Nothing here is a permission check by itself: the manager refuses work it is
 * not allowed to do and says which rule stopped it.
 */
export const INTEGRATION_ERROR_CODES = [
  'INTEGRATION_PROJECT_NOT_FOUND',
  'INTEGRATION_CHANGE_SET_NOT_FOUND',
  'INTEGRATION_APPROVAL_MISSING',
  'INTEGRATION_APPROVAL_REJECTED',
  'INTEGRATION_APPROVAL_STALE',
  'INTEGRATION_APPROVAL_SCOPE_MISMATCH',
  'INTEGRATION_CHANGE_SET_INVALID',
  'INTEGRATION_CHANGE_SET_STALE',
  'INTEGRATION_CHANGE_SET_CONFLICTED',
  'INTEGRATION_CHANGE_SET_ALREADY_INTEGRATED',
  'INTEGRATION_PROJECT_LOCKED',
  'INTEGRATION_TOO_MANY_CHANGE_SETS',
  'INTEGRATION_EMPTY_SELECTION',
  'INTEGRATION_APPLY_FAILED',
  'INTEGRATION_ROLLBACK_UNAVAILABLE',
  'INTEGRATION_ROLLBACK_UNSAFE',
  'INTEGRATION_NOT_FOUND',
  'INTEGRATION_VERIFICATION_UNAVAILABLE',
] as const;
export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: IntegrationErrorCode, message?: string, detail: Record<string, unknown> = {}) {
    super(message ?? code);
    this.name = 'IntegrationError';
    this.code = code;
    this.detail = detail;
  }
}

/** HTTP mapping, kept beside the codes so a route cannot invent a status. */
export function integrationHttpStatus(code: IntegrationErrorCode): number {
  switch (code) {
    case 'INTEGRATION_PROJECT_NOT_FOUND':
    case 'INTEGRATION_CHANGE_SET_NOT_FOUND':
    case 'INTEGRATION_NOT_FOUND':
    case 'INTEGRATION_APPROVAL_MISSING':
      return 404;
    case 'INTEGRATION_PROJECT_LOCKED':
      return 409;
    case 'INTEGRATION_APPROVAL_REJECTED':
    case 'INTEGRATION_APPROVAL_STALE':
    case 'INTEGRATION_APPROVAL_SCOPE_MISMATCH':
    case 'INTEGRATION_CHANGE_SET_INVALID':
    case 'INTEGRATION_CHANGE_SET_STALE':
    case 'INTEGRATION_CHANGE_SET_CONFLICTED':
    case 'INTEGRATION_CHANGE_SET_ALREADY_INTEGRATED':
    case 'INTEGRATION_EMPTY_SELECTION':
    case 'INTEGRATION_TOO_MANY_CHANGE_SETS':
    case 'INTEGRATION_ROLLBACK_UNSAFE':
    case 'INTEGRATION_ROLLBACK_UNAVAILABLE':
      return 409;
    case 'INTEGRATION_VERIFICATION_UNAVAILABLE':
      return 503;
    case 'INTEGRATION_APPLY_FAILED':
      return 500;
    default:
      return 500;
  }
}
