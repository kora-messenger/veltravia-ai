import { describe, expect, it } from 'vitest';

import type { AppTestReport, RunStatus, TestRunState } from '../../api/app-testing';
import {
  approvalCopy,
  canCancel,
  certaintyLabel,
  countsOf,
  environmentCopy,
  headline,
  isActive,
  isFinished,
  primaryAction,
  severityRank,
  severityTone,
  stateLabel,
  statusLabel,
  statusTone,
} from './view-model';

const STATES: readonly TestRunState[] = [
  'created',
  'planning',
  'awaiting_approval',
  'approved',
  'running',
  'analyzing',
  'awaiting_repair_approval',
  'repairing',
  'retesting',
  'completed',
  'failed',
  'cancelled',
];

function status(state: TestRunState, pending: RunStatus['pendingApproval'] = null): RunStatus {
  return {
    runId: 'run-1',
    state,
    projectId: 'prj-1',
    workspaceId: 'ws-1',
    pendingApproval: pending,
    repairAttempts: 0,
    commandsExecuted: 0,
    failure: null,
    notes: [],
  };
}

function report(overrides: Partial<AppTestReport> = {}): AppTestReport {
  return {
    projectId: 'prj-1',
    runId: 'run-1',
    environment: {
      runtimeId: 'container',
      osIsolation: true,
      executedRealCode: true,
      networkPolicy: 'disabled',
    },
    status: 'PASSED',
    statusReason: 'All 3 tests passed.',
    executed: 3,
    passed: 3,
    failed: 0,
    skipped: 0,
    tests: [],
    bugs: [],
    findings: [],
    regression: { ran: false, total: 0, passed: 0, failed: 0, regressed: [], fixed: [], note: '' },
    fullyTested: true,
    generatedAt: '2026-11-05T10:00:00.000Z',
    ...overrides,
  };
}

describe('status wording', () => {
  it('labels every one of the five statuses', () => {
    expect(statusLabel('PASSED')).toBe('Passed');
    expect(statusLabel('FAILED')).toBe('Failed');
    expect(statusLabel('PARTIALLY_PASSED')).toBe('Partially passed');
    expect(statusLabel('CANCELLED')).toBe('Cancelled');
    expect(statusLabel('BLOCKED')).toBe('Blocked');
  });

  it('only shows the success colour for a full pass', () => {
    expect(statusTone('PASSED')).toBe('success');
    for (const other of ['FAILED', 'PARTIALLY_PASSED', 'CANCELLED', 'BLOCKED'] as const) {
      expect(statusTone(other), other).not.toBe('success');
    }
  });

  it('shows a partial pass as a warning, not as success', () => {
    expect(statusTone('PARTIALLY_PASSED')).toBe('warning');
  });

  it('has a plain-words label for every run state', () => {
    for (const state of STATES) expect(stateLabel(state).length, state).toBeGreaterThan(3);
  });
});

describe('live versus finished', () => {
  it('treats exactly the three end states as finished', () => {
    expect(STATES.filter(isFinished).sort()).toEqual(['cancelled', 'completed', 'failed']);
  });

  it('keeps polling only while the run can still change by itself', () => {
    expect(STATES.filter(isActive).sort()).toEqual([
      'analyzing',
      'approved',
      'created',
      'planning',
      'repairing',
      'retesting',
      'running',
    ]);
  });

  it('does not poll while waiting for a person: only they can move it', () => {
    expect(isActive('awaiting_approval')).toBe(false);
    expect(isActive('awaiting_repair_approval')).toBe(false);
  });

  it('never calls a state both finished and active', () => {
    for (const state of STATES) expect(isActive(state) && isFinished(state), state).toBe(false);
  });
});

describe('what the person is asked to approve', () => {
  it('explains each kind of approval and that nothing runs without it', () => {
    expect(approvalCopy({ kind: 'plan_approval' })?.detail).toContain(
      'Nothing runs until you approve',
    );
    expect(approvalCopy({ kind: 'tool_confirmation' })?.title).toBe('Approve running a command');
    expect(approvalCopy({ kind: 'repair_approval' })?.detail).toContain('only if you approve');
  });

  it('says tests run again after a repair', () => {
    expect(approvalCopy({ kind: 'repair_approval' })?.detail).toContain('tests run again');
  });

  it('falls back to a generic prompt for an unknown kind, never to nothing', () => {
    expect(approvalCopy({ kind: 'something_new' })?.title).toBe('Your decision is needed');
  });

  it('shows no approval card when nothing is pending', () => {
    expect(approvalCopy(null)).toBeNull();
  });
});

describe('what ran the tests', () => {
  it('says plainly that a simulated runtime does not execute real code', () => {
    const text = environmentCopy(
      report({
        environment: {
          runtimeId: 'mock',
          osIsolation: false,
          executedRealCode: false,
          networkPolicy: 'disabled',
        },
      }),
    );
    expect(text).toContain('does not execute real code');
    expect(text).toContain('not how your app behaves');
    expect(text).toContain('no OS-level isolation');
  });

  it('claims isolation only when the runtime has it', () => {
    expect(environmentCopy(report())).toContain('with OS-level isolation');
    const noIso = environmentCopy(
      report({
        environment: {
          runtimeId: 'worker',
          osIsolation: false,
          executedRealCode: true,
          networkPolicy: 'disabled',
        },
      }),
    );
    expect(noIso).not.toContain('with OS-level isolation');
  });
});

describe('the headline', () => {
  it('says all tests passed only for a fully tested report', () => {
    expect(headline(report())).toBe('All 3 tests passed.');
  });

  it('uses the report’s own reason when it was not fully tested', () => {
    const partial = report({
      status: 'PARTIALLY_PASSED',
      fullyTested: false,
      statusReason: 'No test failed, but the commands ran on a runtime that executes no real code.',
    });
    expect(headline(partial)).toBe(partial.statusReason);
    expect(headline(partial)).not.toContain('All 3 tests passed');
  });

  it('never says "all passed" for a blocked or failed report', () => {
    for (const status of ['BLOCKED', 'FAILED', 'CANCELLED'] as const) {
      const text = headline(
        report({ status, fullyTested: false, statusReason: 'It did not finish.' }),
      );
      expect(text, status).not.toMatch(/all .* passed/i);
    }
  });
});

describe('bugs', () => {
  it('tells a confirmed failure from a suspicion', () => {
    expect(certaintyLabel({ certainty: 'confirmed' })).toContain('failing test');
    expect(certaintyLabel({ certainty: 'suspected' })).toContain('not confirmed');
  });

  it('ranks severities most serious first', () => {
    expect(severityRank('critical')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('medium'));
    expect(severityRank('medium')).toBeLessThan(severityRank('low'));
    expect(severityRank('low')).toBeLessThan(severityRank('info'));
  });

  it('colours serious bugs as errors and minor ones as neutral', () => {
    expect(severityTone('critical')).toBe('error');
    expect(severityTone('high')).toBe('error');
    expect(severityTone('medium')).toBe('warning');
    expect(severityTone('low')).toBe('neutral');
    expect(severityTone('info')).toBe('neutral');
  });
});

describe('counts and actions', () => {
  it('reads the counts straight from the report', () => {
    expect(countsOf(report({ passed: 5, failed: 2, skipped: 1, executed: 7 }))).toEqual({
      passed: 5,
      failed: 2,
      skipped: 1,
      executed: 7,
    });
  });

  it('offers Start before any run exists', () => {
    expect(primaryAction(null)).toBe('start');
  });

  it('offers Rerun once a run has finished', () => {
    for (const state of ['completed', 'failed', 'cancelled'] as const) {
      expect(primaryAction(status(state)), state).toBe('rerun');
    }
  });

  it('offers no run action while waiting for a person to decide', () => {
    expect(primaryAction(status('awaiting_approval', { kind: 'plan_approval' }))).toBe('none');
  });

  it('offers Cancel while a run is working', () => {
    expect(primaryAction(status('running'))).toBe('cancel');
  });

  it('allows cancelling until the run is finished, including while it waits for a decision', () => {
    expect(canCancel(status('running'))).toBe(true);
    expect(canCancel(status('awaiting_approval', { kind: 'plan_approval' }))).toBe(true);
    expect(canCancel(status('completed'))).toBe(false);
    expect(canCancel(status('cancelled'))).toBe(false);
    expect(canCancel(null)).toBe(false);
  });
});
