import { OrchestrationError } from '@veltravia/orchestration-core';

import type { WorkerStatus } from './types.js';

export type WorkerFailureCode =
  | 'WORKER_NOT_FOUND'
  | 'WORKER_ASSIGNMENT_INVALID'
  | 'WORKER_TRANSITION_INVALID'
  | 'WORKER_VERSION_CONFLICT'
  | 'WORKER_DUPLICATE_ASSIGNMENT'
  | 'WORKER_RESOURCE_CONFLICT'
  | 'WORKER_LIMIT_REACHED'
  | 'WORKER_NOT_CANCELLABLE'
  | 'WORKER_RETRY_REFUSED'
  | 'WORKER_REVIEW_REFUSED'
  | 'WORKER_SCOPE_INVALID'
  | 'WORKER_CANCELLED'
  | 'WORKER_PROVIDER_UNAVAILABLE'
  | 'WORKER_SPENDING_LIMIT'
  | 'WORKER_MODEL_BUDGET_EXCEEDED'
  | 'WORKER_TOKEN_BUDGET_EXCEEDED'
  | 'WORKER_TOOL_BUDGET_EXCEEDED'
  | 'WORKER_OUTPUT_TOO_LARGE'
  | 'WORKER_SECRET_REJECTED'
  | 'WORKER_INTERNAL';

const MESSAGES: Record<WorkerFailureCode, string> = {
  WORKER_NOT_FOUND: 'That worker was not found.',
  WORKER_ASSIGNMENT_INVALID: 'That assignment is not complete enough to run.',
  WORKER_TRANSITION_INVALID: 'That is not a step this worker can take from where it is.',
  WORKER_VERSION_CONFLICT: 'This worker changed since you read it. Read it again.',
  WORKER_DUPLICATE_ASSIGNMENT: 'That task already has an active worker.',
  WORKER_RESOURCE_CONFLICT: 'Another worker holds a conflicting claim on those paths.',
  WORKER_LIMIT_REACHED: 'The concurrency limit for this owner is already in use.',
  WORKER_NOT_CANCELLABLE: 'That worker has already finished.',
  WORKER_RETRY_REFUSED: 'This worker has used every attempt it was allowed.',
  WORKER_REVIEW_REFUSED: 'That result cannot be reviewed in its current state.',
  WORKER_SPENDING_LIMIT: 'This work has reached its spending limit.',
  WORKER_PROVIDER_UNAVAILABLE: 'No AI provider is connected, so no worker can think about this.',
  WORKER_CANCELLED: 'The worker was cancelled before it finished.',
  WORKER_MODEL_BUDGET_EXCEEDED: 'That worker used every model call it was allowed.',
  WORKER_TOKEN_BUDGET_EXCEEDED: 'That worker used its token budget.',
  WORKER_TOOL_BUDGET_EXCEEDED: 'That worker used every tool call it was allowed.',
  WORKER_OUTPUT_TOO_LARGE: 'The tool output for that worker grew past the size it was allowed.',
  WORKER_SCOPE_INVALID: 'That scope is not inside the project this task belongs to.',
  WORKER_SECRET_REJECTED: 'That text looks like a credential and was refused.',
  WORKER_INTERNAL: 'The worker could not be managed.',
};

export class WorkerError extends Error {
  readonly code: WorkerFailureCode;
  readonly detail: Record<string, unknown>;

  constructor(code: WorkerFailureCode, message?: string, detail: Record<string, unknown> = {}) {
    super(message ?? MESSAGES[code]);
    this.name = 'WorkerError';
    this.code = code;
    this.detail = detail;
  }
}

export function isWorkerError(value: unknown): value is WorkerError {
  return value instanceof WorkerError;
}

export function workerHttpStatus(code: WorkerFailureCode): number {
  switch (code) {
    case 'WORKER_NOT_FOUND':
      return 404;
    case 'WORKER_ASSIGNMENT_INVALID':
      // A body that cannot be run as written: 422, not a state conflict.
      return 422;
    case 'WORKER_TRANSITION_INVALID':
    case 'WORKER_NOT_CANCELLABLE':
    case 'WORKER_RETRY_REFUSED':
    case 'WORKER_REVIEW_REFUSED':
    case 'WORKER_SCOPE_INVALID':
    case 'WORKER_CANCELLED':
    case 'WORKER_PROVIDER_UNAVAILABLE':
    case 'WORKER_SPENDING_LIMIT':
    case 'WORKER_MODEL_BUDGET_EXCEEDED':
    case 'WORKER_TOKEN_BUDGET_EXCEEDED':
    case 'WORKER_TOOL_BUDGET_EXCEEDED':
      return 409;
    case 'WORKER_VERSION_CONFLICT':
    case 'WORKER_DUPLICATE_ASSIGNMENT':
    case 'WORKER_RESOURCE_CONFLICT':
    case 'WORKER_LIMIT_REACHED':
      return 409;
    case 'WORKER_SECRET_REJECTED':
    case 'WORKER_OUTPUT_TOO_LARGE':
      return 422;
    case 'WORKER_INTERNAL':
      return 500;
  }
}

/**
 * Maps an orchestration failure onto the worker surface.
 *
 * The task rules are not re-implemented here: a task that a worker cannot start
 * is the task manager's answer, and this keeps its code and its HTTP meaning
 * rather than inventing a parallel one.
 */
export function fromOrchestrationError(error: unknown): WorkerError | null {
  if (!(error instanceof OrchestrationError)) return null;
  if (error.code === 'TASK_NOT_FOUND') return new WorkerError('WORKER_NOT_FOUND');
  return null;
}

export const STATUS_LABELS: Record<WorkerStatus, string> = {
  queued: 'Queued',
  assigned: 'Assigned',
  starting: 'Starting',
  running: 'Running',
  blocked: 'Blocked',
  partially_completed: 'Partially completed',
  awaiting_review: 'Awaiting review',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
};
