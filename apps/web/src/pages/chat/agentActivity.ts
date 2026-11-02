import type { ActivityCategory, AgentActivityEvent } from '@veltravia/shared';

/**
 * The words the timeline uses.
 *
 * Kept out of the components so the phrasing can be tested without rendering,
 * and so one place decides what a status is called. Nothing here invents an
 * outcome: a status word is only ever a rename of a status the server sent.
 */

export interface ActivityRow {
  /** A parent with children, or a lone activity. */
  readonly parent: AgentActivityEvent;
  readonly children: readonly AgentActivityEvent[];
}

/**
 * Folds the flat list into rows.
 *
 * A child never appears on its own: if its parent is missing (a page that joined
 * mid-run with a trimmed buffer) the child is promoted to a row rather than
 * disappearing, because hiding real work is worse than a slightly flatter list.
 */
export function toRows(activities: readonly AgentActivityEvent[]): ActivityRow[] {
  const byId = new Map(activities.map((activity) => [activity.activityId, activity]));
  const childrenOf = new Map<string, AgentActivityEvent[]>();
  const roots: AgentActivityEvent[] = [];
  for (const activity of activities) {
    const parentId = activity.parentActivityId;
    if (parentId !== null && byId.has(parentId)) {
      const existing = childrenOf.get(parentId) ?? [];
      existing.push(activity);
      childrenOf.set(parentId, existing);
      continue;
    }
    roots.push(activity);
  }
  return roots.map((parent) => ({
    parent,
    children: (childrenOf.get(parent.activityId) ?? [])
      .slice()
      .sort((a, b) => a.sequence - b.sequence),
  }));
}

/** Categories that are a command run in a sandbox, so they wear the code mark. */
const COMMAND_CATEGORIES: readonly ActivityCategory[] = [
  'executing_tool',
  'running_tests',
  'linting',
  'building',
  'validating',
  'installing_dependencies',
  'checking_dependencies',
];

export function isCommandActivity(category: ActivityCategory): boolean {
  return COMMAND_CATEGORIES.includes(category);
}

export const STATUS_WORD: Record<string, string> = {
  pending: 'Queued',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
  awaiting_approval: 'Waiting for approval',
};

export function statusWord(status: string): string {
  return STATUS_WORD[status] ?? 'Unknown';
}

/** The line above the rows: what the run is doing, or how it ended. */
export function runHeadline(
  activities: readonly AgentActivityEvent[],
  runStatus: string | null,
): string {
  const running = runStatus === 'running' || runStatus === null;
  const live = activities.filter((activity) => activity.status === 'running');
  const current = live[live.length - 1];
  if (running) {
    if (current === undefined) return 'Working on it';
    return current.title;
  }
  if (runStatus === 'awaiting_confirmation') return 'Waiting for your approval';
  if (runStatus === 'cancelled') return 'Stopped';
  // A failed step and a failed run are different facts, so they get different
  // words: the task can finish having lost only the step it tried and retried.
  if (runStatus === 'failed') return 'Finished with a failure';
  const failed = activities.filter((activity) => activity.status === 'failed').length;
  if (failed === 1) return 'Finished with one failed step';
  if (failed > 1) return `Finished with ${failed} failed steps`;
  return 'Finished';
}

/** "3 steps" / "1 step", counted from rows the person can actually see. */
export function countLabel(count: number): string {
  return count === 1 ? '1 step' : `${count} steps`;
}

export function formatWhen(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
