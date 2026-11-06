import type {
  SyncChange,
  SyncConflict,
  SyncHistoryEntry,
  SyncPlan,
  SyncStatusView,
  SkippedFile,
} from '../../api/sync';

/**
 * What the GitHub sync page shows, decided without a browser.
 *
 * The rules here are the honest part of the screen: a plan is only "ready to
 * apply" when the server said so AND nothing is left for a person to decide.
 * Nothing in this module invents progress, and nothing claims a sync happened
 * because a button was pressed.
 */

export type PagePhase =
  'loading' | 'offline' | 'error' | 'disconnected' | 'connected' | 'planning' | 'no-changes';

export interface StatusBadge {
  readonly label: string;
  readonly tone: 'neutral' | 'positive' | 'caution' | 'negative';
}

export interface PlanSummary {
  readonly pushed: number;
  readonly pulled: number;
  readonly conflicts: number;
  readonly skipped: number;
  readonly unchanged: number;
  readonly headline: string;
  /** Plain language for anything a person still has to decide. */
  readonly blockers: readonly string[];
  readonly canApply: boolean;
  readonly needsApproval: boolean;
}

const CHANGE_WORD: Record<SyncChange['kind'], string> = {
  add: 'added',
  modify: 'changed',
  delete: 'removed',
  rename: 'renamed',
};

const CONFLICT_WORD: Record<SyncConflict['kind'], string> = {
  'both-modified': 'changed on both sides',
  'both-added': 'added on both sides',
  'deleted-locally': 'deleted here, changed on GitHub',
  'deleted-remotely': 'deleted on GitHub, changed here',
};

const SKIP_WORD: Record<string, string> = {
  'not-text': 'not a text file',
  'too-large': 'too large',
  unreadable: 'could not be read',
  'unsafe-path': 'an unsafe path',
  'case-collision': 'clashes with another file by letter case',
  'credential-file': 'a credential file',
  'secret-in-content': 'it looks like it holds a secret',
};

export function describeChange(change: SyncChange): string {
  if (change.kind === 'rename' && change.from !== null)
    return `Renamed ${change.from} to ${change.path}`;
  return `${CHANGE_WORD[change.kind]} ${change.path}`;
}

export function describeSkip(file: SkippedFile): string {
  const where = file.side === 'remote' ? 'on GitHub' : 'in the project';
  const why = SKIP_WORD[file.reason] ?? 'left out';
  return `${file.path} ${where} was left out: it is ${why}.`;
}

export function describeConflict(conflict: SyncConflict): string {
  return `${conflict.path} was ${CONFLICT_WORD[conflict.kind]}.`;
}

export function planSummary(plan: SyncPlan): PlanSummary {
  const unresolved = plan.conflicts.filter((c) => c.resolution === null).length;
  const blockers: string[] = [];
  if (unresolved > 0)
    blockers.push(
      unresolved === 1
        ? 'One file changed on both sides. Choose which version to keep.'
        : `${String(unresolved)} files changed on both sides. Choose which version to keep.`,
    );
  if (plan.status === 'needs-approval' && !plan.approved)
    blockers.push('This sync changes files on GitHub, so it needs your approval first.');
  if (plan.status === 'failed' && plan.failure !== null) blockers.push(plan.failure.message);

  const pushed = plan.push.length;
  const pulled = plan.pull.length;
  const parts: string[] = [];
  if (pushed > 0) parts.push(`${String(pushed)} to publish`);
  if (pulled > 0) parts.push(`${String(pulled)} to bring in`);
  if (pushed === 0 && pulled === 0) parts.push('Nothing to move');

  return {
    pushed,
    pulled,
    conflicts: plan.conflicts.length,
    skipped: plan.skipped.length,
    unchanged: plan.unchanged,
    headline: parts.join(', '),
    blockers,
    canApply: plan.status !== 'failed' && unresolved === 0 && blockers.length === 0,
    needsApproval: plan.status === 'needs-approval' && !plan.approved,
  };
}

export function connectionBadge(status: SyncStatusView): StatusBadge {
  if (!status.connected) return { label: 'Not connected', tone: 'neutral' };
  if (status.hasUnresolvedConflicts) return { label: 'Needs a decision', tone: 'caution' };
  return { label: 'Connected', tone: 'positive' };
}

/** Which of the page's mutually exclusive states applies. */
export function pagePhase(input: {
  readonly loading: boolean;
  readonly offline: boolean;
  readonly error: string | null;
  readonly status: SyncStatusView | null;
  readonly planning: boolean;
  readonly plan: SyncPlan | null;
}): PagePhase {
  if (input.loading) return 'loading';
  if (input.offline) return 'offline';
  if (input.error !== null || input.status === null) return 'error';
  if (!input.status.connected) return 'disconnected';
  if (input.planning) return 'planning';
  if (input.plan !== null) {
    const summary = planSummary(input.plan);
    if (summary.pushed === 0 && summary.pulled === 0 && summary.conflicts === 0)
      return 'no-changes';
  }
  return 'connected';
}

export function repositoryLabel(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function shortCommit(sha: string | null): string {
  if (sha === null || sha.length < 7) return sha ?? '';
  return sha.slice(0, 7);
}

export function historyLine(entry: SyncHistoryEntry): string {
  if (entry.outcome === 'failure')
    return entry.failureCode === null
      ? 'The sync failed.'
      : `The sync failed (${entry.failureCode}).`;
  const parts: string[] = [];
  if (entry.added.length > 0) parts.push(`${String(entry.added.length)} added`);
  if (entry.modified.length > 0) parts.push(`${String(entry.modified.length)} changed`);
  if (entry.deleted.length > 0) parts.push(`${String(entry.deleted.length)} removed`);
  if (entry.pulled > 0) parts.push(`${String(entry.pulled)} brought in`);
  const moved = parts.length === 0 ? 'Nothing moved' : parts.join(', ');
  return entry.commitSha === null
    ? `${moved}. Nothing was published.`
    : `${moved}. Published ${shortCommit(entry.commitSha)}.`;
}

/** The time of a sync, in the reader's own clock, or the raw text if unreadable. */
export function whenText(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString();
}
