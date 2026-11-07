/**
 * Orchestration failures, each with one meaning and one HTTP answer.
 *
 * Two rules the codes enforce:
 *  - "not found" and "not yours" are the same answer, so an id cannot be
 *    probed for existence;
 *  - a refused state change names the states involved, so a client can tell an
 *    invalid transition from a version conflict.
 */

export type OrchestrationErrorCode =
  | 'TASK_NOT_FOUND'
  | 'TASK_INVALID'
  | 'TASK_SCOPE_REQUIRED'
  | 'TASK_PROJECT_FORBIDDEN'
  | 'TASK_TRANSITION_INVALID'
  | 'TASK_VERSION_CONFLICT'
  | 'TASK_RETRY_REFUSED'
  | 'TASK_REVIEW_INVALID'
  | 'TASK_DEPENDENCY_INVALID'
  | 'TASK_DEPENDENCY_CYCLE'
  | 'TASK_DEPENDENCY_LIMIT'
  | 'TASK_SECRET_REJECTED'
  | 'TASK_LIMIT_REACHED'
  | 'ASSIGNMENT_INVALID'
  | 'PRIMARY_AGENT_CONFLICT'
  | 'ORCHESTRATION_UNAVAILABLE';

const MESSAGES: Record<OrchestrationErrorCode, string> = {
  TASK_NOT_FOUND: 'That task was not found.',
  TASK_INVALID: 'A task needs a title and an objective.',
  TASK_SCOPE_REQUIRED: 'A task must be created in a project the caller owns.',
  TASK_PROJECT_FORBIDDEN: 'That project or workspace was not found.',
  TASK_TRANSITION_INVALID: 'That task cannot move to the requested state.',
  TASK_VERSION_CONFLICT: 'This task changed since you last read it. Fetch it again.',
  TASK_RETRY_REFUSED: 'This task cannot be retried again.',
  TASK_REVIEW_INVALID: 'Only a task awaiting review can be accepted or sent back.',
  TASK_DEPENDENCY_INVALID: 'That dependency is not a task in the same project.',
  TASK_DEPENDENCY_CYCLE: 'That dependency would create a loop.',
  TASK_DEPENDENCY_LIMIT: 'A task can have at most 25 dependencies.',
  TASK_SECRET_REJECTED: 'That text looks like it contains a credential, so it was refused.',
  TASK_LIMIT_REACHED: 'This owner has reached the task limit.',
  ASSIGNMENT_INVALID: 'That assignment is not usable.',
  PRIMARY_AGENT_CONFLICT: 'An owner can have only one primary agent.',
  ORCHESTRATION_UNAVAILABLE: 'Task records are unavailable right now.',
};

export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;

  constructor(code: OrchestrationErrorCode, message?: string) {
    super(message ?? MESSAGES[code]);
    this.name = 'OrchestrationError';
    this.code = code;
  }
}

export function isOrchestrationError(error: unknown): error is OrchestrationError {
  return error instanceof OrchestrationError;
}

export function orchestrationHttpStatus(code: OrchestrationErrorCode): number {
  switch (code) {
    case 'TASK_INVALID':
    case 'TASK_SCOPE_REQUIRED':
    case 'TASK_TRANSITION_INVALID':
    case 'TASK_REVIEW_INVALID':
    case 'TASK_DEPENDENCY_INVALID':
    case 'TASK_DEPENDENCY_CYCLE':
    case 'TASK_DEPENDENCY_LIMIT':
    case 'ASSIGNMENT_INVALID':
    case 'TASK_RETRY_REFUSED':
      return 400;
    case 'TASK_NOT_FOUND':
    case 'TASK_PROJECT_FORBIDDEN':
      return 404;
    case 'TASK_VERSION_CONFLICT':
    case 'PRIMARY_AGENT_CONFLICT':
      return 409;
    case 'TASK_SECRET_REJECTED':
      return 422;
    case 'TASK_LIMIT_REACHED':
      return 429;
    case 'ORCHESTRATION_UNAVAILABLE':
      return 503;
  }
}
