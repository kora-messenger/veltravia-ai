/**
 * The task lifecycle.
 *
 * One table, no exceptions. A client cannot invent a state change: it can ask,
 * and the answer comes from here. The two edges that carry a policy are not
 * bare transitions:
 *
 *   failed -> queued        only through `retry`, which checks the attempt budget
 *   awaiting_review -> completed  only through a recorded review decision, and
 *                                 only a rejection can send work back
 *
 * `completed` and `cancelled` are terminal. Reopening work means a new task,
 * so history is never rewritten.
 */

import { OrchestrationError } from './errors.js';
import type { TaskStatus } from './types.js';
import { TASK_STATUSES } from './types.js';

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['planning', 'assigned', 'running', 'cancelled'],
  planning: ['assigned', 'running', 'blocked', 'failed', 'cancelled'],
  assigned: ['running', 'blocked', 'failed', 'cancelled'],
  running: [
    'awaiting_review',
    'partially_completed',
    'blocked',
    'completed',
    'failed',
    'cancelled',
  ],
  blocked: ['planning', 'assigned', 'running', 'failed', 'cancelled'],
  partially_completed: ['running', 'awaiting_review', 'completed', 'failed', 'cancelled'],
  awaiting_review: ['completed', 'running', 'partially_completed', 'cancelled'],
  completed: [],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

/** Transitions a client may not request directly, whatever the graph says. */
const GUARDED: readonly string[] = ['failed->queued', 'awaiting_review->completed'];

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function transitionIsGuarded(from: TaskStatus, to: TaskStatus): boolean {
  return GUARDED.includes(`${from}->${to}`);
}

export function isKnownStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new OrchestrationError(
      'TASK_TRANSITION_INVALID',
      `A task cannot move from ${from} to ${to}.`,
    );
  }
}
