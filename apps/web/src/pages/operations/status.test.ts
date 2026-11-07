import { describe, expect, it } from 'vitest';

import type { VerificationRunView, WorkerUsageView } from '../../api/operations';
import {
  canCancel,
  canReview,
  countByOp,
  formatDuration,
  notificationsFor,
  describeRefusal,
  summariseUsage,
  summariseVerification,
  workerGroup,
  workerDuration,
} from './status';

function run(overrides: Partial<VerificationRunView> = {}): VerificationRunView {
  return {
    id: 'vr_1',
    projectId: 'prj_1',
    taskId: null,
    workerId: null,
    revision: '12',
    status: 'passed',
    requestedOperations: ['unit'],
    blocked: [],
    results: [],
    evidence: {
      executed: true,
      executedCount: 1,
      passedCount: 1,
      failedCount: 0,
      status: 'passed',
      finishedAt: '2026-11-07T09:00:00.000Z',
    },
    startedAt: '2026-11-07T08:59:00.000Z',
    finishedAt: '2026-11-07T09:00:00.000Z',
    ...overrides,
  };
}

const result = (counts: {
  discovered: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
}) => ({
  operation: 'unit',
  commandId: 'npm:test',
  label: 'Unit tests',
  argv: ['npm', 'run', 'test', '--silent'],
  status: 'passed',
  exitCode: 0,
  durationMs: 100,
  counts,
  buildStatus: 'not_applicable',
  errorSummary: null,
  outputTail: '',
  truncated: false,
  reason: null,
  providesOsIsolation: false,
});

describe('verification honesty', () => {
  it('never calls a run without an executed command a success', () => {
    const summary = summariseVerification(
      run({
        status: 'incomplete',
        evidence: {
          executed: false,
          executedCount: 0,
          passedCount: 0,
          failedCount: 0,
          status: 'incomplete',
          finishedAt: null,
        },
      }),
    );
    expect(summary.executed).toBe(false);
    expect(summary.tone).toBe('warning');
    expect(summary.headline).toContain('Nothing ran');
  });

  it('names the operation and reason a run was refused', () => {
    const summary = summariseVerification(
      run({
        status: 'incomplete',
        blocked: [{ operation: 'e2e', reason: 'not_allowed', detail: 'Outside scope.' }],
        evidence: {
          executed: false,
          executedCount: 0,
          passedCount: 0,
          failedCount: 0,
          status: 'incomplete',
          finishedAt: null,
        },
      }),
    );
    expect(summary.headline).toContain('e2e');
    expect(summary.headline).toContain('not allowed');
  });

  it('reports a green run with no test counts as build-only, not as passing tests', () => {
    const summary = summariseVerification(
      run({
        results: [result({ discovered: null, passed: null, failed: null, skipped: null })],
      }),
    );
    expect(summary.executed).toBe(true);
    expect(summary.tone).toBe('warning');
    expect(summary.headline).toContain('no test counts');
  });

  it('sums real counts and calls a failing run failed', () => {
    const summary = summariseVerification(
      run({
        status: 'failed',
        results: [result({ discovered: 5, passed: 3, failed: 2, skipped: 0 })],
        evidence: {
          executed: true,
          executedCount: 1,
          passedCount: 0,
          failedCount: 1,
          status: 'failed',
          finishedAt: '2026-11-07T09:00:00.000Z',
        },
      }),
    );
    expect(summary.tone).toBe('error');
    expect(summary.counts).toEqual({ passed: 3, failed: 2, skipped: 0 });
    expect(summary.headline).toContain('2 failing tests');
  });
});

describe('refusals', () => {
  it('keeps the server sentence and spaces the bare check codes', () => {
    const refusal = describeRefusal(
      'The review found blocking problems: acceptance_criteria_len, acceptance_criteria_met.',
    );
    expect(refusal.intro).toBe('The review found blocking problems:');
    expect(refusal.codes).toEqual(['acceptance criteria len', 'acceptance criteria met']);
  });

  it('passes an ordinary message through untouched', () => {
    const message = 'The claimed test run does not exist.';
    expect(describeRefusal(message)).toEqual({ intro: message, codes: [] });
  });
});

describe('usage provenance', () => {
  it('marks a simulated worker as simulated', () => {
    const usage: WorkerUsageView = {
      providerId: null,
      modelId: null,
      modelCalls: 0,
      toolCalls: 4,
      inputTokens: 0,
      outputTokens: 0,
      live: false,
    };
    const summary = summariseUsage(usage);
    expect(summary.provenance).toBe('simulated');
    expect(summary.tokens).toBe('No tokens recorded');
  });

  it('says so when nothing was recorded at all', () => {
    expect(summariseUsage(null).provenance).toBe('unknown');
    expect(summariseUsage(undefined).calls).toBe('Not recorded');
  });
});

describe('status vocabulary', () => {
  it('groups the lifecycle without inventing a group', () => {
    expect(workerGroup('starting')).toBe('active');
    expect(workerGroup('partially_completed')).toBe('awaiting_review');
    expect(workerGroup('timed_out')).toBe('failed');
  });

  it('only offers controls the server will accept', () => {
    expect(canCancel('running')).toBe(true);
    expect(canCancel('awaiting_review')).toBe(false);
    expect(canReview('awaiting_review')).toBe(true);
    expect(canReview('completed')).toBe(false);
  });

  it('counts file operations', () => {
    expect(
      countByOp([{ op: 'create' }, { op: 'update' }, { op: 'update' }, { op: 'rename' }]),
    ).toEqual({ create: 1, update: 2, delete: 0 });
  });

  it('formats durations and missing durations honestly', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(640)).toBe('640 ms');
    expect(formatDuration(12_400)).toBe('12.4 s');
    expect(formatDuration(95_000)).toBe('1m 35s');
    expect(workerDuration({ startedAt: null, endedAt: null })).toBeNull();
  });
});

describe('notifications', () => {
  const seen = new Set<string>();

  it('announces a failure once and not again on the next read', () => {
    const before = { workers: [{ id: 'w1', status: 'running' as const }], taskStatuses: {} };
    const after = { workers: [{ id: 'w1', status: 'failed' as const }], taskStatuses: {} };
    const first = notificationsFor(before, after, seen);
    expect(first.map((item) => item.event)).toContain('worker_failed');
    for (const item of first) seen.add(item.key);
    expect(notificationsFor(after, after, seen)).toHaveLength(0);
  });

  it('does not announce routine progress', () => {
    const before = { workers: [{ id: 'w1', status: 'queued' as const }], taskStatuses: {} };
    const after = { workers: [{ id: 'w1', status: 'running' as const }], taskStatuses: {} };
    expect(notificationsFor(before, after, new Set())).toHaveLength(0);
  });

  it('announces review readiness and task completion', () => {
    const before = {
      workers: [{ id: 'w1', status: 'running' as const }],
      taskStatuses: { t1: 'running' as const },
    };
    const after = {
      workers: [{ id: 'w1', status: 'awaiting_review' as const }],
      taskStatuses: { t1: 'completed' as const },
    };
    const events = notificationsFor(before, after, new Set()).map((item) => item.event);
    expect(events).toContain('approval_required');
    expect(events).toContain('task_completed');
  });
});
