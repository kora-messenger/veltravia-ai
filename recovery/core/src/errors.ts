/** Errors that carry a code the API can map to a status without guessing. */
export class RecoveryError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'RecoveryError';
    this.code = code;
    this.status = status;
  }
}

export const recoveryHttpStatus = (code: string): number => {
  switch (code) {
    case 'RECOVERY_CASE_NOT_FOUND':
      return 404;
    case 'RECOVERY_BUDGET_EXHAUSTED':
      return 409;
    case 'RECOVERY_BACKOFF_ACTIVE':
      return 409;
    case 'RECOVERY_CASE_CLOSED':
      return 409;
    case 'RECOVERY_DIAGNOSIS_INSUFFICIENT':
      return 409;
    case 'RECOVERY_POLICY_REFUSAL':
      return 409;
    case 'RECOVERY_NEEDS_HUMAN':
      return 409;
    case 'RECOVERY_CONCURRENCY_LIMIT':
      return 409;
    case 'RECOVERY_DUPLICATE_ATTEMPT':
      return 409;
    case 'RECOVERY_PERMISSION_EXPANSION':
      return 422;
    case 'RECOVERY_SCOPE_EXPANSION':
      return 422;
    case 'RECOVERY_VERIFICATION_REQUIRED':
      return 409;
    case 'RECOVERY_INPUT_INVALID':
      return 400;
    default:
      return 500;
  }
};
