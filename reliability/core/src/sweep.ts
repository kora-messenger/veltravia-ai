/**
 * The sweep decision.
 *
 * After a crash or a restart somebody has to look at each open execution and
 * decide what it needs. That decision is made here, from records only, and it is
 * deliberately small: this is not a recovery classification (Step 48 owns that)
 * and it does not repair anything. It answers one question per execution -
 * re-read the evidence, recover the dead workers, wait for the owner, or leave
 * it alone - and says why.
 *
 * The rules that matter:
 *  - a closed execution is never resumed;
 *  - an execution another holder is working on right now is skipped, so two
 *    processes cannot resume it at once;
 *  - an interrupted operation is never assumed to have succeeded: `resume`
 *    re-reads every linked record before anything is written;
 *  - a blocked execution waits for a person, because being blocked means a
 *    decision this system cannot make.
 */

export type SweepAction = 'resume' | 'recover' | 'await_owner' | 'leave';

export interface SweepSubject {
  readonly executionId: string;
  readonly status: string;
  /** When the executor last recorded a decision or wrote the record. */
  readonly lastActivityAt: string | null;
  /** Who holds the coordinator lease, and whether it has run out. */
  readonly leaseHolder: string | null;
  readonly leaseExpired: boolean;
  readonly workers: readonly {
    readonly workerId: string;
    readonly status: string;
    /** Age of the last heartbeat, in milliseconds, or null when never started. */
    readonly heartbeatAgeMs: number | null;
  }[];
  readonly tasks: readonly { readonly taskId: string; readonly status: string }[];
}

export interface SweepDecision {
  readonly executionId: string;
  readonly action: SweepAction;
  readonly reason: string;
  /** What was observed, so the record explains itself later. */
  readonly evidence: readonly string[];
  /** What the owner has to do, when the decision needs them. */
  readonly ownerAction: string | null;
}

const CLOSED = new Set(['completed', 'cancelled', 'failed']);

/** A worker that has not said anything for this long is not running any more. */
export const STALE_HEARTBEAT_MS = 90 * 1000;

export function decideSweep(subject: SweepSubject): SweepDecision {
  const evidence: string[] = [`execution status is ${subject.status}`];
  if (subject.lastActivityAt !== null) {
    evidence.push(`last recorded activity at ${subject.lastActivityAt}`);
  }

  if (CLOSED.has(subject.status)) {
    return {
      executionId: subject.executionId,
      action: 'leave',
      reason: `The execution is ${subject.status}; nothing is resumed.`,
      evidence,
      ownerAction: null,
    };
  }

  if (subject.leaseHolder !== null && !subject.leaseExpired) {
    return {
      executionId: subject.executionId,
      action: 'leave',
      reason: 'Another holder is working on this execution right now.',
      evidence: [...evidence, `lease held by ${subject.leaseHolder}`],
      ownerAction: null,
    };
  }
  if (subject.leaseHolder !== null && subject.leaseExpired) {
    evidence.push(`lease held by ${subject.leaseHolder} expired without being released`);
  }

  const stale = subject.workers.filter(
    (worker) =>
      (worker.status === 'running' || worker.status === 'starting') &&
      (worker.heartbeatAgeMs === null || worker.heartbeatAgeMs >= STALE_HEARTBEAT_MS),
  );
  if (stale.length > 0) {
    for (const worker of stale) {
      evidence.push(
        worker.heartbeatAgeMs === null
          ? `${worker.workerId} is ${worker.status} and has never reported a heartbeat`
          : `${worker.workerId} is ${worker.status} and last reported ${
              Math.round((worker.heartbeatAgeMs ?? 0) / 1000)
            }s ago`,
      );
    }
    return {
      executionId: subject.executionId,
      action: 'recover',
      reason: `${stale.length} worker${stale.length === 1 ? '' : 's'} stopped reporting, so their work has to be closed before the plan can move.`,
      evidence,
      ownerAction: null,
    };
  }

  const blocked = subject.tasks.filter((task) => task.status === 'blocked');
  if (blocked.length > 0) {
    for (const task of blocked) evidence.push(`task ${task.taskId} is blocked`);
    return {
      executionId: subject.executionId,
      action: 'await_owner',
      reason: 'Work is blocked on a decision this system is not allowed to make.',
      evidence,
      ownerAction: 'Open the execution and decide the blocked approval or work item.',
    };
  }

  const active = subject.workers.filter((worker) =>
    ['queued', 'assigned', 'starting', 'running', 'awaiting_review'].includes(worker.status),
  );
  for (const worker of active) evidence.push(`${worker.workerId} is ${worker.status}`);
  return {
    executionId: subject.executionId,
    action: 'resume',
    reason:
      active.length === 0
        ? 'No worker is active, so the stored evidence is re-read and the execution is re-derived from it.'
        : 'Active work exists; re-reading the evidence is what turns it into progress.',
    evidence,
    ownerAction: null,
  };
}

/**
 * Which executions a sweep should even look at. An execution touched moments ago
 * by a live process is not abandoned; one that has not moved since long before
 * the stale window is.
 */
export function isAbandoned(subject: SweepSubject, at: string): boolean {
  if (CLOSED.has(subject.status)) return false;
  if (subject.leaseHolder !== null && !subject.leaseExpired) return false;
  if (subject.lastActivityAt === null) return true;
  return Date.parse(at) - Date.parse(subject.lastActivityAt) >= STALE_HEARTBEAT_MS;
}
