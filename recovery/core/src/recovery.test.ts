import { describe, expect, it } from 'vitest';

import { detectFailures } from './classify.js';
import { diagnose } from './diagnose.js';
import { RecoveryManager } from './manager.js';
import { backoffFor, budgetOf, canAttempt, clampLimits } from './policy.js';
import { assertContained, assessRecovery, buildRepairPlan } from './repair.js';
import { InMemoryRecoveryStore, observationFixture, verificationFixture } from './testing.js';
import type { FailureObservation, RecoveryCaseRecord } from './types.js';

const OWNER = 'owner-1';

function manager(): { manager: RecoveryManager; store: InMemoryRecoveryStore } {
  const store = new InMemoryRecoveryStore();
  return { manager: new RecoveryManager({ store }), store };
}

async function openedCase(overrides: Partial<FailureObservation> = {}): Promise<{
  manager: RecoveryManager;
  record: RecoveryCaseRecord;
}> {
  const { manager: m } = manager();
  const record = await m.detect({ ownerRef: OWNER, observation: observationFixture(overrides) });
  return { manager: m, record };
}

describe('failure classification', () => {
  it('reads a timeout as temporary and retryable', () => {
    const findings = detectFailures(
      observationFixture({ workerStatus: 'timed_out', failure: null }),
    );
    expect(findings[0]?.category).toBe('timeout');
    expect(findings[0]?.classification).toBe('temporary');
    expect(findings[0]?.evidence[0]?.detail).toContain('deadline');
  });

  it('reads a crash as temporary', () => {
    const findings = detectFailures(
      observationFixture({
        failure: { code: 'WORKER_EXECUTOR_CRASH', message: 'boom', retryable: true },
      }),
    );
    expect(findings[0]?.category).toBe('worker_crash');
    expect(findings[0]?.classification).toBe('temporary');
  });

  it('treats a cancellation as a human decision, not a retry', () => {
    const findings = detectFailures(
      observationFixture({ workerStatus: 'cancelled', failure: null }),
    );
    expect(findings[0]?.category).toBe('cancelled');
    expect(findings[0]?.classification).toBe('needs_human');
  });

  it('counts missing deliverables against what was declared', () => {
    const findings = detectFailures(
      observationFixture({
        workerStatus: 'awaiting_review',
        failure: null,
        produced: {
          deliverables: ['src/settings/load.ts'],
          criteriaMet: 2,
          summary: '',
          simulated: false,
        },
      }),
    );
    const missing = findings.find((finding) => finding.category === 'missing_deliverables');
    expect(missing?.detail).toContain('1 of 2');
  });

  it('catches a completion claim that outran its evidence', () => {
    const findings = detectFailures(
      observationFixture({
        workerStatus: 'awaiting_review',
        failure: null,
        produced: {
          deliverables: ['src/settings/load.ts', 'notes.md'],
          criteriaMet: 1,
          summary: 'done',
          simulated: false,
        },
      }),
    );
    expect(findings.map((finding) => finding.category)).toContain('unverified_completion');
  });

  it('catches a completion claim with no verification run when the criteria demand one', () => {
    const findings = detectFailures(
      observationFixture({
        workerStatus: 'completed',
        failure: null,
        produced: {
          deliverables: ['src/settings/load.ts', 'notes.md'],
          criteriaMet: 2,
          summary: 'done',
          simulated: false,
        },
      }),
    );
    const unverified = findings.find((finding) => finding.category === 'unverified_completion');
    expect(unverified?.detail).toContain('no verification run exists');
  });

  it.each([
    ['test', 'failed_tests'],
    ['typecheck', 'type_errors'],
    ['lint', 'lint_failures'],
    ['build', 'build_failures'],
  ])('maps a failed %s to %s', (operation, category) => {
    const findings = detectFailures(
      observationFixture({
        workerStatus: 'awaiting_review',
        failure: null,
        verification: verificationFixture({ status: 'failed', failedOperations: [operation] }),
      }),
    );
    expect(findings[0]?.category).toBe(category);
    expect(findings[0]?.classification).toBe('permanent');
  });

  it('never retries a policy refusal', () => {
    const findings = detectFailures(
      observationFixture({
        failure: { code: 'WORKER_TOOL_FORBIDDEN', message: 'not allowed', retryable: false },
      }),
    );
    expect(findings[0]?.category).toBe('permission_refused');
    expect(findings[0]?.classification).toBe('policy');
  });

  it('separates a refused tool from a malformed one', () => {
    const refused = detectFailures(
      observationFixture({
        toolErrors: [
          { tool: 'project.write', code: 'FORBIDDEN', message: 'outside scope', refused: true },
        ],
      }),
    );
    const malformed = detectFailures(
      observationFixture({
        toolErrors: [
          { tool: 'project.write', code: 'INVALID_INPUT', message: 'bad args', refused: false },
        ],
      }),
    );
    expect(refused[0]?.category).toBe('permission_refused');
    expect(malformed[0]?.category).toBe('invalid_tool_call');
  });

  it('detects a stale revision from the two revisions it was given', () => {
    const findings = detectFailures(
      observationFixture({ revision: { atStart: 'rev_1', now: 'rev_9' } }),
    );
    expect(findings.map((finding) => finding.category)).toContain('stale_revision');
  });

  it('detects a change-set conflict and asks for a person', () => {
    const findings = detectFailures(
      observationFixture({
        conflicts: [
          {
            changeSetId: 'chg_1',
            kinds: ['same_file'],
            detail: 'src/settings/load.ts was changed',
          },
        ],
      }),
    );
    const conflict = findings.find((finding) => finding.category === 'change_conflict');
    expect(conflict?.classification).toBe('needs_human');
  });

  it('reports repeated attempts', () => {
    const findings = detectFailures(
      observationFixture({ attempts: 3, previousAttempts: ['timeout', 'failed tests'] }),
    );
    expect(findings.map((finding) => finding.category)).toContain('repeated_attempts');
  });

  it('returns unknown rather than inventing a cause', () => {
    const findings = detectFailures(
      observationFixture({
        workerStatus: 'awaiting_review',
        failure: null,
        declaration: {
          ...observationFixture().declaration,
          deliverables: [],
          acceptanceCriteria: ['Something happens'],
        },
        produced: { deliverables: [], criteriaMet: null, summary: 'ok', simulated: false },
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.category).toBe('unknown');
  });
});

describe('diagnosis', () => {
  it('recommends a bounded retry for a temporary failure', () => {
    const diagnosis = diagnose(observationFixture({ workerStatus: 'timed_out', failure: null }));
    expect(diagnosis.primary).toBe('timeout');
    expect(diagnosis.recommendedAction).toBe('retry_same_worker');
    expect(diagnosis.confidence).not.toBe('insufficient');
    expect(diagnosis.likelyCause).toContain('ceiling');
  });

  it('names the missing deliverables as the affected work', () => {
    const diagnosis = diagnose(
      observationFixture({
        workerStatus: 'awaiting_review',
        failure: null,
        produced: {
          deliverables: ['src/settings/load.ts'],
          criteriaMet: 2,
          summary: '',
          simulated: false,
        },
      }),
    );
    expect(diagnosis.affectedDeliverables).toEqual(['notes.md']);
    expect(diagnosis.recommendedAction).toBe('reassign_worker');
  });

  it('declines to diagnose when the evidence does not identify a cause', () => {
    const diagnosis = diagnose(
      observationFixture({
        workerStatus: 'awaiting_review',
        failure: null,
        declaration: {
          ...observationFixture().declaration,
          deliverables: [],
          acceptanceCriteria: [],
        },
        produced: { deliverables: [], criteriaMet: null, summary: '', simulated: false },
      }),
    );
    expect(diagnosis.insufficient).toBe(true);
    expect(diagnosis.primary).toBeNull();
    expect(diagnosis.recommendedAction).toBeNull();
    expect(diagnosis.confidence).toBe('insufficient');
  });
});

describe('repair planning', () => {
  it('builds a plan from the missing work, not from scratch', () => {
    const observation = observationFixture({
      workerStatus: 'awaiting_review',
      failure: null,
      produced: {
        deliverables: ['src/settings/load.ts'],
        criteriaMet: 1,
        summary: '',
        simulated: false,
      },
    });
    const diagnosis = diagnose(observation);
    const plan = buildRepairPlan({ diagnosis, observation, attempt: 1, limits: clampLimits(null) });
    expect(plan.deliverables.map((item) => item.name)).toEqual(['notes.md']);
    // A name with a file extension is a file deliverable; free text is notes.
    expect(plan.deliverables[0]?.kind).toBe('file');
    expect(plan.deliverables[0]?.path).toBe('notes.md');
  });

  it('excludes what was already delivered', () => {
    const observation = observationFixture({
      workerStatus: 'awaiting_review',
      failure: null,
      produced: {
        deliverables: ['src/settings/load.ts'],
        criteriaMet: 1,
        summary: '',
        simulated: false,
      },
    });
    const plan = buildRepairPlan({
      diagnosis: diagnose(observation),
      observation,
      attempt: 1,
      limits: clampLimits(null),
    });
    expect(plan.exclusions).toEqual(['src/settings/load.ts']);
    expect(plan.objective).toContain('not to be rewritten');
  });

  it('demands verification evidence when tests failed', () => {
    const observation = observationFixture({
      workerStatus: 'awaiting_review',
      failure: null,
      verification: verificationFixture({ status: 'failed', failedOperations: ['test'] }),
    });
    const plan = buildRepairPlan({
      diagnosis: diagnose(observation),
      observation,
      attempt: 1,
      limits: clampLimits(null),
    });
    expect(plan.verification).toEqual({ operations: ['test'] });
    expect(plan.acceptanceCriteria.join(' ')).toContain('Verification evidence is required');
    expect(plan.workerType).toBe('testing');
  });

  it('refuses a plan that widens the scope', () => {
    const observation = observationFixture();
    const plan = buildRepairPlan({
      diagnosis: diagnose(observation),
      observation,
      attempt: 1,
      limits: clampLimits(null),
    });
    expect(() => assertContained(plan, observation)).not.toThrow();
    expect(() => assertContained({ ...plan, scope: ['src/secrets'] }, observation)).toThrowError(
      /scope/,
    );
  });

  it('refuses a plan that asks for a tool the worker never held', () => {
    const observation = observationFixture();
    const plan = buildRepairPlan({
      diagnosis: diagnose(observation),
      observation,
      attempt: 1,
      limits: clampLimits(null),
    });
    expect(() =>
      assertContained(
        { ...plan, allowedTools: [...plan.allowedTools, 'network.fetch'] },
        observation,
      ),
    ).toThrowError(/tool/);
  });

  it('refuses a plan that asks for a permission the worker never held', () => {
    const observation = observationFixture({
      declaration: {
        ...observationFixture().declaration,
        permissions: { readProject: true, writeProject: true, runTools: true, network: false },
      },
    });
    const plan = buildRepairPlan({
      diagnosis: diagnose(observation),
      observation,
      attempt: 1,
      limits: clampLimits(null),
    });
    expect(() =>
      assertContained(
        { ...plan, permissions: { ...plan.permissions, network: true } },
        observation,
      ),
    ).toThrowError(/network/);
  });
});

describe('budgets and backoff', () => {
  it('doubles backoff from the base and caps it', () => {
    const limits = clampLimits({ backoffBaseMs: 1_000, backoffCeilingMs: 5_000 });
    expect(backoffFor(1, limits)).toBe(0);
    expect(backoffFor(2, limits)).toBe(1_000);
    expect(backoffFor(3, limits)).toBe(2_000);
    expect(backoffFor(9, limits)).toBe(5_000);
  });

  it('clamps a caller to the hard ceilings', () => {
    const limits = clampLimits({ maxAttempts: 99, maxConcurrentRepairs: 99 });
    expect(limits.maxAttempts).toBe(5);
    expect(limits.maxConcurrentRepairs).toBe(4);
  });

  it('refuses another attempt once the attempt budget is spent', async () => {
    const { manager: m, record } = await openedCase();
    const spent: RecoveryCaseRecord = { ...record, attempts: record.limits.maxAttempts };
    const decision = canAttempt({
      record: spent,
      diagnosis: record.diagnosis,
      now: new Date(),
      activeRepairs: 0,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.rejection).toBe('budget_exhausted');
    expect(budgetOf(spent, new Date()).attemptsRemaining).toBe(0);
    await expect(m.plan(OWNER, record.id)).resolves.toBeTruthy();
  });

  it('refuses while backoff is still running', async () => {
    const { manager: m, record } = await openedCase();
    const waiting: RecoveryCaseRecord = {
      ...record,
      nextAttemptNotBefore: new Date(Date.now() + 60_000).toISOString(),
    };
    const decision = canAttempt({
      record: waiting,
      diagnosis: waiting.diagnosis,
      now: new Date(),
      activeRepairs: 0,
    });
    expect(decision.rejection).toBe('backoff_waiting');
    expect(decision.waitedMs).toBeGreaterThan(0);
    expect(m).toBeTruthy();
  });

  it('refuses beyond the concurrency ceiling', async () => {
    const { record } = await openedCase();
    const decision = canAttempt({
      record,
      diagnosis: record.diagnosis,
      now: new Date(),
      activeRepairs: record.limits.maxConcurrentRepairs,
    });
    expect(decision.rejection).toBe('concurrency_limit');
  });

  it('refuses to retry a policy refusal', async () => {
    const { manager: m } = manager();
    const record = await m.detect({
      ownerRef: OWNER,
      observation: observationFixture({
        failure: { code: 'WORKER_TOOL_FORBIDDEN', message: 'refused', retryable: false },
      }),
    });
    await expect(m.plan(OWNER, record.id)).rejects.toMatchObject({
      code: 'RECOVERY_POLICY_REFUSAL',
    });
  });
});

describe('case lifecycle', () => {
  it('opens a case with its diagnosis recorded', async () => {
    const { record } = await openedCase({ workerStatus: 'timed_out', failure: null });
    expect(record.status).toBe('open');
    expect(record.diagnosis?.primary).toBe('timeout');
    expect(record.eventSeq).toBe(2);
  });

  it('escalates immediately when the evidence cannot support a repair', async () => {
    const { manager: m } = manager();
    const record = await m.detect({
      ownerRef: OWNER,
      observation: observationFixture({
        workerStatus: 'awaiting_review',
        failure: null,
        declaration: {
          ...observationFixture().declaration,
          deliverables: [],
          acceptanceCriteria: [],
        },
        produced: { deliverables: [], criteriaMet: null, summary: '', simulated: false },
      }),
    });
    expect(record.status).toBe('escalated');
    expect(record.escalation?.reason).toBe('insufficient_evidence');
    // An escalated case is closed to further attempts, whichever gate fires first.
    await expect(m.plan(OWNER, record.id)).rejects.toMatchObject({
      code: 'RECOVERY_CASE_CLOSED',
    });
  });

  it('refuses a plan for an open case whose diagnosis was declined', async () => {
    const { manager: m, record } = await openedCase({ workerStatus: 'timed_out', failure: null });
    const declined = await m.reanalyse(
      OWNER,
      record.id,
      observationFixture({
        workerStatus: 'awaiting_review',
        failure: null,
        declaration: {
          ...observationFixture().declaration,
          deliverables: [],
          acceptanceCriteria: [],
        },
        produced: { deliverables: [], criteriaMet: null, summary: '', simulated: false },
      }),
    );
    expect(declined.diagnosis?.insufficient).toBe(true);
    await expect(m.plan(OWNER, record.id)).rejects.toMatchObject({
      code: 'RECOVERY_DIAGNOSIS_INSUFFICIENT',
    });
  });

  it('plans, starts and finishes an attempt with proof, and recovers', async () => {
    const { manager: m, record } = await openedCase({ workerStatus: 'timed_out', failure: null });
    const plan = await m.plan(OWNER, record.id);
    expect(plan.action).toBe('retry_same_worker');
    const started = await m.startAttempt({
      ownerRef: OWNER,
      caseId: record.id,
      action: plan.action,
      workerId: 'wkr_repair_1',
      workerType: plan.workerType,
    });
    const finished = await m.finishAttempt({
      ownerRef: OWNER,
      caseId: record.id,
      attemptId: started.attempt.id,
      outcome: 'succeeded',
      summary: 'loader written',
      verification: verificationFixture(),
      changeSetId: 'chg_1',
      integrated: true,
      currentRevision: 'rev_1',
    });
    expect(finished.recovered).toBe(true);
    expect(finished.record.status).toBe('recovered');
    expect(finished.record.revisionAtRecovery).toBe('rev_1');
  });

  it('does not accept a claimed success without an executed run', async () => {
    const { manager: m, record } = await openedCase();
    const plan = await m.plan(OWNER, record.id);
    const started = await m.startAttempt({
      ownerRef: OWNER,
      caseId: record.id,
      action: plan.action,
      workerId: 'wkr_repair_1',
      workerType: plan.workerType,
    });
    const finished = await m.finishAttempt({
      ownerRef: OWNER,
      caseId: record.id,
      attemptId: started.attempt.id,
      outcome: 'succeeded',
      summary: 'trust me',
      verification: verificationFixture({
        executed: false,
        status: 'incomplete',
        executedCount: 0,
      }),
      changeSetId: 'chg_1',
      integrated: true,
    });
    expect(finished.recovered).toBe(false);
    expect(finished.record.status).toBe('awaiting_verification');
    expect(finished.reason).toContain('actually executed');
  });

  it('does not accept verification that never executed', () => {
    const verdict = assessRecovery({
      verification: verificationFixture({ executed: false, status: 'incomplete' }),
      changeSetId: null,
      integrated: false,
      notes: [],
    });
    expect(verdict.recovered).toBe(false);
    expect(verdict.missing).toContain('a verification run that actually executed');
  });

  it('requires an approved integration before claiming recovery', () => {
    const verdict = assessRecovery({
      verification: verificationFixture(),
      changeSetId: 'chg_1',
      integrated: false,
      notes: [],
    });
    expect(verdict.recovered).toBe(false);
    expect(verdict.reason).toContain('approved integration');
  });

  it('refuses a second running attempt for the same case', async () => {
    const { manager: m, record } = await openedCase();
    const plan = await m.plan(OWNER, record.id);
    await m.startAttempt({
      ownerRef: OWNER,
      caseId: record.id,
      action: plan.action,
      workerId: 'wkr_a',
      workerType: plan.workerType,
    });
    await expect(
      m.startAttempt({
        ownerRef: OWNER,
        caseId: record.id,
        action: plan.action,
        workerId: 'wkr_b',
        workerType: plan.workerType,
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_DUPLICATE_ATTEMPT' });
  });

  it('records a reassignment when the work moves to another worker', async () => {
    const { manager: m, record } = await openedCase();
    const plan = await m.plan(OWNER, record.id);
    const started = await m.startAttempt({
      ownerRef: OWNER,
      caseId: record.id,
      action: 'reassign_worker',
      workerId: 'wkr_other',
      workerType: plan.workerType,
    });
    expect(started.record.reassignments).toBe(1);
  });

  it('escalates when the last attempt fails and the budget is spent', async () => {
    const { manager: m } = manager();
    const record = await m.detect({
      ownerRef: OWNER,
      observation: observationFixture(),
      limits: { maxAttempts: 1 },
    });
    const plan = await m.plan(OWNER, record.id);
    const started = await m.startAttempt({
      ownerRef: OWNER,
      caseId: record.id,
      action: plan.action,
      workerId: 'wkr_x',
      workerType: plan.workerType,
    });
    const finished = await m.finishAttempt({
      ownerRef: OWNER,
      caseId: record.id,
      attemptId: started.attempt.id,
      outcome: 'failed',
      summary: 'still broken',
    });
    expect(finished.record.status).toBe('escalated');
    expect(finished.record.escalation?.reason).toBe('budget_exhausted');
    expect(finished.record.escalation?.attempted[0]).toContain('attempt 1');
  });

  it('keeps an accepted change set out of the repair', async () => {
    const { manager: m, record } = await openedCase();
    const updated = await m.preserve(OWNER, record.id, 'chg_accepted');
    expect(updated.preservedChangeSets).toEqual(['chg_accepted']);
    const again = await m.preserve(OWNER, record.id, 'chg_accepted');
    expect(again.preservedChangeSets).toEqual(['chg_accepted']);
  });

  it('rejects a stale plan when the project has moved', async () => {
    const { manager: m, record } = await openedCase();
    await expect(m.plan(OWNER, record.id, { currentRevision: 'rev_2' })).rejects.toMatchObject({
      code: 'RECOVERY_STALE_REVISION',
    });
  });

  it('cancels a case and refuses further attempts', async () => {
    const { manager: m, record } = await openedCase();
    const cancelled = await m.cancel(OWNER, record.id, 'Owner stopped it.');
    expect(cancelled.status).toBe('cancelled');
    await expect(m.plan(OWNER, record.id)).rejects.toMatchObject({
      code: 'RECOVERY_CASE_CLOSED',
    });
  });

  it('cannot escalate a recovered case', async () => {
    const { manager: m, record } = await openedCase({ workerStatus: 'timed_out', failure: null });
    const plan = await m.plan(OWNER, record.id);
    const started = await m.startAttempt({
      ownerRef: OWNER,
      caseId: record.id,
      action: plan.action,
      workerId: 'wkr_ok',
      workerType: plan.workerType,
    });
    await m.finishAttempt({
      ownerRef: OWNER,
      caseId: record.id,
      attemptId: started.attempt.id,
      outcome: 'succeeded',
      summary: 'fixed',
      verification: verificationFixture(),
      changeSetId: null,
      integrated: false,
    });
    await expect(
      m.escalate({ ownerRef: OWNER, caseId: record.id, reason: 'needs_human', message: 'hmm' }),
    ).rejects.toMatchObject({ code: 'RECOVERY_CASE_CLOSED' });
  });

  it('isolates owners', async () => {
    const { manager: m, record } = await openedCase();
    await expect(m.inspect('someone-else', record.id)).rejects.toMatchObject({
      code: 'RECOVERY_CASE_NOT_FOUND',
    });
    expect(await m.list('someone-else', {})).toHaveLength(0);
  });

  it('records the audit trail in order', async () => {
    const { manager: m, record } = await openedCase({ workerStatus: 'timed_out', failure: null });
    const plan = await m.plan(OWNER, record.id);
    await m.startAttempt({
      ownerRef: OWNER,
      caseId: record.id,
      action: plan.action,
      // Same worker as the failure: a retry, not a reassignment.
      workerId: 'wkr_1',
      workerType: plan.workerType,
    });
    const events = await m.events(OWNER, record.id);
    expect(events.map((event) => event.type)).toEqual([
      'failure_detected',
      'diagnosed',
      'repair_planned',
      'repair_started',
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe('restart recovery', () => {
  it('marks an in-flight attempt abandoned and lets the case continue once', async () => {
    const { manager: m, record } = await openedCase({ workerStatus: 'timed_out', failure: null });
    const plan = await m.plan(OWNER, record.id);
    const started = await m.startAttempt({
      ownerRef: OWNER,
      caseId: record.id,
      action: plan.action,
      workerId: 'wkr_crash',
      workerType: plan.workerType,
    });
    const resumed = await m.resume({
      ownerRef: OWNER,
      caseId: record.id,
      currentRevision: 'rev_1',
    });
    expect(resumed.status).toBe('repairing');
    const attempts = await m.attempts(OWNER, record.id);
    expect(attempts.find((attempt) => attempt.id === started.attempt.id)?.outcome).toBe(
      'abandoned',
    );
    // The abandoned attempt must not be resumable as if it were still running.
    await expect(
      m.finishAttempt({
        ownerRef: OWNER,
        caseId: record.id,
        attemptId: started.attempt.id,
        outcome: 'succeeded',
        summary: 'ghost',
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_DUPLICATE_ATTEMPT' });
    const next = await m.plan(OWNER, record.id);
    expect(next.action).toBe('retry_same_worker');
  });

  it('reopens the case when the project moved during the restart', async () => {
    const { manager: m, record } = await openedCase();
    await m.plan(OWNER, record.id);
    const resumed = await m.resume({
      ownerRef: OWNER,
      caseId: record.id,
      currentRevision: 'rev_9',
    });
    expect(resumed.status).toBe('open');
    expect(resumed.observation.revision.now).toBe('rev_9');
  });
});

describe('multi-worker repair', () => {
  it('hands a failing backend worker to a testing worker and closes on evidence', async () => {
    const { manager: m } = manager();
    const failed = await m.detect({
      ownerRef: OWNER,
      observation: observationFixture({
        workerStatus: 'awaiting_review',
        failure: null,
        produced: {
          deliverables: ['src/settings/load.ts', 'notes.md'],
          criteriaMet: 2,
          summary: 'written, tests failing',
          simulated: false,
        },
        verification: verificationFixture({ status: 'failed', failedOperations: ['test'] }),
      }),
    });
    expect(failed.diagnosis?.primary).toBe('failed_tests');
    const plan = await m.plan(OWNER, failed.id);
    expect(plan.workerType).toBe('testing');
    expect(plan.verification).toEqual({ operations: ['test'] });
    const started = await m.startAttempt({
      ownerRef: OWNER,
      caseId: failed.id,
      action: plan.action,
      workerId: 'wkr_test_1',
      workerType: 'testing',
    });
    expect(started.record.reassignments).toBe(1);
    const done = await m.finishAttempt({
      ownerRef: OWNER,
      caseId: failed.id,
      attemptId: started.attempt.id,
      outcome: 'succeeded',
      summary: 'fixed the loader and re-ran tests',
      verification: verificationFixture({ runId: 'run_2' }),
      changeSetId: 'chg_2',
      integrated: true,
      currentRevision: 'rev_1',
    });
    expect(done.recovered).toBe(true);
    const attempts = await m.attempts(OWNER, failed.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.verificationRunId).toBe('run_2');
    expect(attempts[0]?.changeSetId).toBe('chg_2');
  });

  it('stops after the attempt budget and keeps the evidence', async () => {
    const { manager: m } = manager();
    const record = await m.detect({
      ownerRef: OWNER,
      observation: observationFixture(),
      // A 1ms backoff keeps the test honest about ordering without waiting.
      limits: { maxAttempts: 2, backoffBaseMs: 1, backoffCeilingMs: 1 },
    });
    for (let index = 0; index < 2; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const plan = await m.plan(OWNER, record.id);
      const started = await m.startAttempt({
        ownerRef: OWNER,
        caseId: record.id,
        action: plan.action,
        workerId: `wkr_try_${index}`,
        workerType: plan.workerType,
      });
      await m.finishAttempt({
        ownerRef: OWNER,
        caseId: record.id,
        attemptId: started.attempt.id,
        outcome: 'failed',
        summary: `attempt ${index + 1} failed`,
      });
    }
    const final = await m.inspect(OWNER, record.id);
    expect(final.status).toBe('escalated');
    expect(final.attempts).toBe(2);
    expect(final.escalation?.attempted).toHaveLength(2);
    await expect(m.plan(OWNER, record.id)).rejects.toMatchObject({
      code: 'RECOVERY_CASE_CLOSED',
    });
    const attempts = await m.attempts(OWNER, record.id);
    expect(attempts.every((attempt) => attempt.summary !== null)).toBe(true);
  });
});
