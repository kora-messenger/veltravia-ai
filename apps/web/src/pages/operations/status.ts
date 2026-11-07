import type { BadgeTone } from '../../components/ui/Badge';
import type {
  ChangeSetStatus,
  TaskStatus,
  VerificationRunView,
  WorkerStatus,
  WorkerUsageView,
} from '../../api/operations';

/**
 * The words and colours the operations dashboard uses.
 *
 * One module so the summary tiles, the tables and the detail panel cannot
 * disagree about what "awaiting review" looks like or which statuses count as
 * live. Nothing here decides *behaviour*: the server owns the lifecycle, this
 * file only names it.
 */

export type WorkerGroup =
  'active' | 'queued' | 'awaiting_review' | 'blocked' | 'failed' | 'cancelled' | 'completed';

export const WORKER_GROUP_ORDER: readonly WorkerGroup[] = [
  'active',
  'queued',
  'awaiting_review',
  'blocked',
  'failed',
  'cancelled',
  'completed',
];

export const WORKER_GROUP_LABEL: Record<WorkerGroup, string> = {
  active: 'Running',
  queued: 'Queued',
  awaiting_review: 'Awaiting review',
  blocked: 'Blocked',
  failed: 'Failed',
  cancelled: 'Cancelled',
  completed: 'Completed',
};

/**
 * Which group a status belongs to.
 *
 * `timed_out` is grouped with `failed` because both need a person to look, and
 * `partially_completed` with `awaiting_review` because neither is finished.
 */
export function workerGroup(status: WorkerStatus): WorkerGroup {
  switch (status) {
    case 'running':
    case 'starting':
    case 'assigned':
      return 'active';
    case 'queued':
      return 'queued';
    case 'awaiting_review':
    case 'partially_completed':
      return 'awaiting_review';
    case 'blocked':
      return 'blocked';
    case 'failed':
    case 'timed_out':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'completed':
      return 'completed';
    default:
      return 'active';
  }
}

export const WORKER_STATUS_LABEL: Record<WorkerStatus, string> = {
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

export function workerStatusLabel(status: WorkerStatus): string {
  return WORKER_STATUS_LABEL[status] ?? status;
}

export function workerGroupTone(group: WorkerGroup): BadgeTone {
  switch (group) {
    case 'active':
      return 'info';
    case 'queued':
      return 'neutral';
    case 'awaiting_review':
      return 'warning';
    case 'blocked':
      return 'warning';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'neutral';
    case 'completed':
      return 'success';
    default:
      return 'neutral';
  }
}

/** True when the owner can still cancel: the server refuses anything else. */
export function canCancel(status: WorkerStatus): boolean {
  return (
    status === 'queued' ||
    status === 'assigned' ||
    status === 'starting' ||
    status === 'running' ||
    status === 'blocked' ||
    status === 'partially_completed'
  );
}

/** True when a review decision is meaningful for this worker. */
export function canReview(status: WorkerStatus): boolean {
  return status === 'awaiting_review' || status === 'partially_completed';
}

const TASK_LABEL: Record<TaskStatus, string> = {
  queued: 'Queued',
  planning: 'Planning',
  assigned: 'Assigned',
  running: 'Running',
  blocked: 'Blocked',
  partially_completed: 'Partially completed',
  awaiting_review: 'Awaiting review',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function taskStatusLabel(status: TaskStatus): string {
  return TASK_LABEL[status] ?? status;
}

export function taskStatusTone(status: TaskStatus): BadgeTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'blocked':
    case 'awaiting_review':
    case 'partially_completed':
      return 'warning';
    case 'running':
    case 'assigned':
    case 'planning':
      return 'info';
    default:
      return 'neutral';
  }
}

const CHANGE_SET_LABEL: Record<ChangeSetStatus, string> = {
  open: 'Open',
  validating: 'Validating',
  approved: 'Approved',
  integrating: 'Integrating',
  integrated: 'Integrated',
  rejected: 'Rejected',
  conflicted: 'Conflicted',
  stale: 'Stale',
};

export function changeSetStatusLabel(status: ChangeSetStatus): string {
  return CHANGE_SET_LABEL[status] ?? status;
}

export function changeSetStatusTone(status: ChangeSetStatus): BadgeTone {
  switch (status) {
    case 'integrated':
      return 'success';
    case 'rejected':
    case 'conflicted':
      return 'error';
    case 'stale':
    case 'validating':
      return 'warning';
    case 'approved':
    case 'integrating':
      return 'info';
    default:
      return 'neutral';
  }
}

/** The three file operations, in the order a reviewer scans them. */
export const CHANGE_OPS = ['create', 'update', 'delete'] as const;

export type ChangeOp = (typeof CHANGE_OPS)[number];

export const CHANGE_OP_LABEL: Record<ChangeOp, string> = {
  create: 'Added',
  update: 'Modified',
  delete: 'Deleted',
};

export function countByOp(
  files: readonly { readonly op: string }[],
): Record<'create' | 'update' | 'delete', number> {
  const counts = { create: 0, update: 0, delete: 0 };
  for (const file of files) {
    if (file.op === 'create' || file.op === 'update' || file.op === 'delete') {
      counts[file.op] += 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Verification honesty
// ---------------------------------------------------------------------------

export interface VerificationSummary {
  /** Plain sentence about what actually ran. Never claims more than the record. */
  readonly headline: string;
  /** True only when at least one command really executed. */
  readonly executed: boolean;
  readonly counts: { passed: number; failed: number; skipped: number };
  readonly tone: BadgeTone;
}

/**
 * What a run is allowed to say it did.
 *
 * A run with no executed command is never green: it is "nothing ran", with the
 * reason the server recorded. A connected sandbox that was not configured is
 * reported as missing configuration, and a green run that never ran a test
 * command is reported as a build-only result.
 */
export function summariseVerification(run: VerificationRunView): VerificationSummary {
  const executed = run.evidence?.executed === true && (run.evidence?.executedCount ?? 0) > 0;
  const counts = { passed: 0, failed: 0, skipped: 0 };
  let discovered = false;
  for (const result of run.results) {
    if (result.counts.passed !== null) {
      counts.passed += result.counts.passed;
      discovered = true;
    }
    if (result.counts.failed !== null) counts.failed += result.counts.failed;
    if (result.counts.skipped !== null) counts.skipped += result.counts.skipped;
  }

  if (!executed) {
    const blocked = run.blocked[0];
    const reason =
      blocked !== undefined
        ? `Nothing ran: ${blocked.operation} was refused (${blocked.reason.replace(/_/g, ' ')}).`
        : run.status === 'incomplete'
          ? 'Nothing ran: no verification runtime was configured for this project.'
          : 'Nothing ran.';
    return { headline: reason, executed: false, counts, tone: 'warning' };
  }

  if (run.status === 'failed') {
    return {
      headline:
        counts.failed > 0
          ? `Failed with ${counts.failed} failing ${counts.failed === 1 ? 'test' : 'tests'}.`
          : 'Failed. See the operation results for the exit code and error.',
      executed: true,
      counts,
      tone: 'error',
    };
  }

  if (!discovered) {
    return {
      headline: 'Commands ran but reported no test counts (build or lint only).',
      executed: true,
      counts,
      tone: 'warning',
    };
  }

  return {
    headline: `${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped.`,
    executed: true,
    counts,
    tone: counts.failed > 0 ? 'error' : 'success',
  };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface UsageSummary {
  readonly calls: string;
  readonly tokens: string;
  readonly provenance: 'live' | 'simulated' | 'unknown';
}

/**
 * Usage as the worker recorded it.
 *
 * A simulated run is labelled as simulated: its token counts are real numbers
 * from a fake executor and must never read as billed spend.
 */
export function summariseUsage(usage: WorkerUsageView | null | undefined): UsageSummary {
  if (usage === null || usage === undefined) {
    return { calls: 'Not recorded', tokens: 'Not recorded', provenance: 'unknown' };
  }
  const calls = `${usage.modelCalls} model ${usage.modelCalls === 1 ? 'call' : 'calls'}, ${usage.toolCalls} tool ${usage.toolCalls === 1 ? 'call' : 'calls'}`;
  const tokens =
    usage.inputTokens === 0 && usage.outputTokens === 0
      ? 'No tokens recorded'
      : `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out`;
  return { calls, tokens, provenance: usage.live ? 'live' : 'simulated' };
}

/** Model and provider, or an honest "not recorded" when no model ran. */
export function providerLabel(usage: WorkerUsageView | null | undefined): string {
  if (usage === null || usage === undefined) return 'Not recorded';
  if (usage.providerId === null && usage.modelId === null) return 'No model called';
  return [usage.providerId, usage.modelId].filter((part) => part !== null).join(' · ');
}

/** Durations as a person reads them, and '—' when there is nothing to read. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function workerDuration(worker: {
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}): number | null {
  if (worker.startedAt === null) return null;
  const start = Date.parse(worker.startedAt);
  const end = worker.endedAt === null ? Date.now() : Date.parse(worker.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/** Relative time for a timestamp, without a date library. */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (iso === null) return '—';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '—';
  const delta = Math.max(0, now - at);
  if (delta < 5_000) return 'just now';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * The events worth interrupting a person for.
 *
 * Routine progress (heartbeats, status strolling from queued to running) never
 * notifies. These fire once per worker per state, because the caller tracks
 * what it has already shown.
 */
export type OperationsNotification =
  | 'worker_failed'
  | 'worker_blocked'
  | 'approval_required'
  | 'conflicts_detected'
  | 'verification_failed'
  | 'task_completed'
  | 'integration_succeeded'
  | 'integration_rolled_back';

export const NOTIFICATION_LABEL: Record<OperationsNotification, string> = {
  worker_failed: 'Superagent failed',
  worker_blocked: 'Superagent blocked',
  approval_required: 'Review needed',
  conflicts_detected: 'Conflicts detected',
  verification_failed: 'Verification failed',
  task_completed: 'Task completed',
  integration_succeeded: 'Changes integrated',
  integration_rolled_back: 'Integration rolled back',
};

/**
 * Which notifications a change in state has earned.
 *
 * `seen` holds keys already notified about, so a poll that re-reads the same
 * worker does not re-announce it.
 */
export function notificationsFor(
  previous: {
    readonly workers: readonly { readonly id: string; readonly status: WorkerStatus }[];
    readonly taskStatuses: Readonly<Record<string, TaskStatus>>;
  },
  next: {
    readonly workers: readonly { readonly id: string; readonly status: WorkerStatus }[];
    readonly taskStatuses: Readonly<Record<string, TaskStatus>>;
  },
  seen: Set<string>,
): readonly {
  readonly key: string;
  readonly event: OperationsNotification;
  readonly detail?: string;
}[] {
  const out: { key: string; event: OperationsNotification; detail?: string }[] = [];
  const before = new Map(previous.workers.map((worker) => [worker.id, worker.status]));
  for (const worker of next.workers) {
    const was = before.get(worker.id);
    if (was === worker.status) continue;
    if (worker.status === 'failed' || worker.status === 'timed_out') {
      const key = `${worker.id}:failed`;
      if (!seen.has(key)) out.push({ key, event: 'worker_failed' });
    }
    if (worker.status === 'blocked') {
      const key = `${worker.id}:blocked`;
      if (!seen.has(key)) out.push({ key, event: 'worker_blocked' });
    }
    if (worker.status === 'awaiting_review') {
      const key = `${worker.id}:review`;
      if (!seen.has(key)) out.push({ key, event: 'approval_required' });
    }
  }
  for (const [taskId, status] of Object.entries(next.taskStatuses)) {
    if (previous.taskStatuses[taskId] === status) continue;
    if (status === 'completed') {
      const key = `${taskId}:completed`;
      if (!seen.has(key)) out.push({ key, event: 'task_completed' });
    }
  }
  return out;
}

/** Marks a notification key as shown, and prunes keys for vanished workers. */
export function rememberNotifications(seen: Set<string>, keys: readonly string[]): void {
  for (const key of keys) seen.add(key);
}

/**
 * A refusal keeps the server's own words. The server can list bare check codes
 * ("acceptance_criteria_met"), so the codes are shown on their own line, spaced
 * for reading, and the surrounding sentence is left untouched.
 */
export function describeRefusal(message: string): { intro: string; codes: string[] } {
  const marker = 'blocking problems:';
  const at = message.toLowerCase().indexOf(marker);
  if (at < 0) return { intro: message, codes: [] };
  const intro = message.slice(0, at + marker.length).trim();
  const rest = message.slice(at + marker.length).trim();
  const codes = rest
    .replace(/\.$/, '')
    .split(',')
    .map((code) => code.trim().replace(/_/g, ' '))
    .filter((code) => code.length > 0);
  return { intro, codes };
}
