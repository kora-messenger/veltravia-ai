import { describe, expect, it } from 'vitest';
import type { SyncConflict, SyncPlan, SyncStatusView } from '../../api/sync';
import {
  connectionBadge,
  describeChange,
  describeSkip,
  historyLine,
  pagePhase,
  planSummary,
  shortCommit,
  whenText,
} from './view-model';

function conflict(overrides: Partial<SyncConflict> = {}): SyncConflict {
  return {
    id: 'c1',
    path: 'src/a.ts',
    kind: 'both-modified',
    resolution: null,
    localHash: 'abc',
    remoteHash: 'def',
    ...overrides,
  };
}

export function plan(overrides: Partial<SyncPlan> = {}): SyncPlan {
  return {
    planId: 'plan-1',
    projectId: 'prj-1',
    owner: 'acme',
    repository: 'notes',
    branch: 'main',
    status: 'ready',
    mode: 'update',
    remoteHead: 'a'.repeat(40),
    localRevision: 3,
    push: [],
    pull: [],
    conflicts: [],
    skipped: [],
    unchanged: 0,
    approvalReasons: [],
    approved: false,
    message: '',
    createdAt: '2026-11-06T10:00:00.000Z',
    expiresAt: '2026-11-06T11:00:00.000Z',
    failure: null,
    ...overrides,
  };
}

const connected: SyncStatusView = {
  connected: true,
  connection: {
    owner: 'acme',
    repository: 'notes',
    branch: 'main',
    lastSyncedCommit: 'b'.repeat(40),
    lastSyncedAt: '2026-11-06T09:00:00.000Z',
  },
  plans: [],
  hasUnresolvedConflicts: false,
  persistence: 'memory',
};

describe('planSummary', () => {
  it('counts both directions and says what happens in words', () => {
    const summary = planSummary(
      plan({
        push: [{ kind: 'modify', path: 'a.ts', from: null, hash: 'h', size: 4 }],
        pull: [{ kind: 'add', path: 'b.ts', from: null, hash: 'h', size: 4 }],
        unchanged: 7,
      }),
    );
    expect(summary.headline).toBe('1 to publish, 1 to bring in');
    expect(summary.pushed).toBe(1);
    expect(summary.pulled).toBe(1);
    expect(summary.unchanged).toBe(7);
    expect(summary.blockers).toEqual([]);
    expect(summary.canApply).toBe(true);
  });

  it('never allows applying while a conflict is undecided', () => {
    const summary = planSummary(plan({ conflicts: [conflict()] }));
    expect(summary.canApply).toBe(false);
    expect(summary.blockers).toEqual([
      'One file changed on both sides. Choose which version to keep.',
    ]);
  });

  it('allows applying once every conflict has a decision', () => {
    const summary = planSummary(
      plan({ conflicts: [conflict({ resolution: 'keep-remote' })], status: 'ready' }),
    );
    expect(summary.canApply).toBe(true);
    expect(summary.blockers).toEqual([]);
  });

  it('counts several undecided conflicts in the plural', () => {
    const summary = planSummary(
      plan({ conflicts: [conflict({ id: 'c1' }), conflict({ id: 'c2' })] }),
    );
    expect(summary.blockers[0]).toBe(
      '2 files changed on both sides. Choose which version to keep.',
    );
  });

  it('blocks an unapproved plan that would publish', () => {
    const summary = planSummary(plan({ status: 'needs-approval' }));
    expect(summary.canApply).toBe(false);
    expect(summary.needsApproval).toBe(true);
    expect(summary.blockers).toEqual([
      'This sync changes files on GitHub, so it needs your approval first.',
    ]);
  });

  it('lets an approved plan through', () => {
    const summary = planSummary(plan({ status: 'needs-approval', approved: true }));
    expect(summary.canApply).toBe(true);
    expect(summary.needsApproval).toBe(false);
  });

  it('reports a failed plan with the reason the server gave, and refuses to apply', () => {
    const summary = planSummary(
      plan({
        status: 'failed',
        failure: { code: 'SYNC_REMOTE_CHANGED', message: 'Someone pushed to this branch.' },
      }),
    );
    expect(summary.canApply).toBe(false);
    expect(summary.blockers).toContain('Someone pushed to this branch.');
  });

  it('says nothing is moving rather than showing zeroes', () => {
    expect(planSummary(plan({ unchanged: 12 })).headline).toBe('Nothing to move');
  });
});

describe('pagePhase', () => {
  const base = {
    loading: false,
    offline: false,
    error: null,
    status: connected,
    planning: false,
    plan: null,
  };

  it('puts loading first, then offline, then error', () => {
    expect(pagePhase({ ...base, loading: true, offline: true })).toBe('loading');
    expect(pagePhase({ ...base, offline: true, error: 'x' })).toBe('offline');
    expect(pagePhase({ ...base, error: 'x' })).toBe('error');
    expect(pagePhase({ ...base, status: null })).toBe('error');
  });

  it('shows the connect form when nothing is connected', () => {
    expect(
      pagePhase({ ...base, status: { ...connected, connected: false, connection: null } }),
    ).toBe('disconnected');
  });

  it('shows an empty comparison only when a plan really found nothing', () => {
    expect(pagePhase({ ...base, plan: plan({ unchanged: 4 }) })).toBe('no-changes');
    expect(
      pagePhase({
        ...base,
        plan: plan({ pull: [{ kind: 'add', path: 'b.ts', from: null, hash: 'h', size: 1 }] }),
      }),
    ).toBe('connected');
  });

  it('keeps a plan with only conflicts visible instead of calling it empty', () => {
    expect(pagePhase({ ...base, plan: plan({ conflicts: [conflict()] }) })).toBe('connected');
  });

  it('marks planning while a comparison runs', () => {
    expect(pagePhase({ ...base, planning: true })).toBe('planning');
  });
});

describe('wording', () => {
  it('describes each change kind', () => {
    expect(describeChange({ kind: 'add', path: 'a.ts', from: null, hash: null, size: 0 })).toBe(
      'added a.ts',
    );
    expect(describeChange({ kind: 'modify', path: 'a.ts', from: null, hash: null, size: 0 })).toBe(
      'changed a.ts',
    );
    expect(describeChange({ kind: 'delete', path: 'a.ts', from: null, hash: null, size: 0 })).toBe(
      'removed a.ts',
    );
    expect(
      describeChange({ kind: 'rename', path: 'b.ts', from: 'a.ts', hash: null, size: 0 }),
    ).toBe('Renamed a.ts to b.ts');
  });

  it('says which side a skipped file came from', () => {
    expect(describeSkip({ path: 'logo.png', side: 'remote', reason: 'not-text', detail: '' })).toBe(
      'logo.png on GitHub was left out: it is not a text file.',
    );
    expect(
      describeSkip({ path: '.env', side: 'local', reason: 'credential-file', detail: '' }),
    ).toBe('.env in the project was left out: it is a credential file.');
  });

  it('badges a connection honestly, including when a decision is pending', () => {
    expect(connectionBadge({ ...connected, connected: false }).label).toBe('Not connected');
    expect(connectionBadge(connected)).toEqual({ label: 'Connected', tone: 'positive' });
    expect(connectionBadge({ ...connected, hasUnresolvedConflicts: true }).label).toBe(
      'Needs a decision',
    );
  });

  it('shortens a commit without inventing one', () => {
    expect(shortCommit('abcdef1234567890')).toBe('abcdef1');
    expect(shortCommit(null)).toBe('');
  });
});

describe('historyLine', () => {
  const entry = {
    entryId: 'h1',
    projectId: 'prj-1',
    owner: 'acme',
    repository: 'notes',
    branch: 'main',
    outcome: 'success' as const,
    commitSha: 'abcdef1234567890',
    message: '',
    at: '2026-11-06T10:00:00.000Z',
    added: ['a.ts'],
    modified: ['b.ts'],
    deleted: [],
    pulled: 2,
    conflicts: 0,
    approval: 'approved' as const,
    failureCode: null,
  };

  it('lists what moved and the commit that carries it', () => {
    expect(historyLine(entry)).toBe('1 added, 1 changed, 2 brought in. Published abcdef1.');
  });

  it('says plainly when nothing was published', () => {
    expect(historyLine({ ...entry, commitSha: null, added: [], modified: [], pulled: 1 })).toBe(
      '1 brought in. Nothing was published.',
    );
  });

  it('reports a failure by its code, never as a success', () => {
    expect(
      historyLine({ ...entry, outcome: 'failure', commitSha: null, failureCode: 'SYNC_CANCELLED' }),
    ).toBe('The sync failed (SYNC_CANCELLED).');
  });
});

describe('whenText', () => {
  it('keeps text it cannot parse instead of showing Invalid Date', () => {
    expect(whenText('not a date')).toBe('not a date');
  });
});
