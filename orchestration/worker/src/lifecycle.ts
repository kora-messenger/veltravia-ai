/**
 * The worker lifecycle.
 *
 * Same discipline as the task lifecycle: a closed set of moves, validated in
 * one place. Two rules are structural rather than advisory:
 *  - only review can reach `completed`, so a worker cannot accept its own work;
 *  - only `requeue` (controlled retry) can return a failed or timed-out worker
 *    to `queued`.
 */

import { WorkerError } from './errors.js';
import type { WorkerStatus } from './types.js';

export const WORKER_TRANSITIONS: Record<WorkerStatus, readonly WorkerStatus[]> = {
  queued: ['assigned', 'cancelled'],
  assigned: ['starting', 'cancelled', 'failed'],
  starting: ['running', 'failed', 'timed_out', 'cancelled'],
  running: [
    'awaiting_review',
    'partially_completed',
    'blocked',
    'failed',
    'timed_out',
    'cancelled',
  ],
  blocked: ['starting', 'running', 'failed', 'timed_out', 'cancelled'],
  partially_completed: ['running', 'awaiting_review', 'failed', 'timed_out', 'cancelled'],
  awaiting_review: ['completed', 'running', 'failed', 'cancelled'],
  completed: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
  timed_out: ['queued', 'cancelled'],
};

export function isWorkerStatus(value: unknown): value is WorkerStatus {
  return typeof value === 'string' && value in WORKER_TRANSITIONS;
}

export function canWorkerTransition(from: WorkerStatus, to: WorkerStatus): boolean {
  return WORKER_TRANSITIONS[from].includes(to);
}

export function assertWorkerTransition(from: WorkerStatus, to: WorkerStatus): void {
  if (!canWorkerTransition(from, to)) {
    throw new WorkerError(
      'WORKER_TRANSITION_INVALID',
      `A worker cannot move from ${from} to ${to}.`,
      { from, to },
    );
  }
}

/** True when reaching `to` from `from` is reserved for one specific action. */
export function transitionNeedsAction(
  from: WorkerStatus,
  to: WorkerStatus,
): 'review' | 'requeue' | null {
  if (to === 'completed') return 'review';
  if (to === 'queued' && (from === 'failed' || from === 'timed_out')) return 'requeue';
  return null;
}

export function isTerminalWorkerStatus(status: WorkerStatus): boolean {
  return WORKER_TRANSITIONS[status].length === 0;
}

export function isActiveWorkerStatus(status: WorkerStatus): boolean {
  return !isTerminalWorkerStatus(status);
}
