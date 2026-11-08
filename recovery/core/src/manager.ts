/**
 * The repair coordinator.
 *
 * It owns the decision record, not the execution: workers are created elsewhere,
 * tests are run elsewhere, change sets are integrated elsewhere. What it owns is
 * the ordering and the honesty — nothing closes as recovered without an executed
 * passing verification and an approved integration, and no attempt starts
 * outside the budget.
 */

import { diagnose } from './diagnose.js';
import { RecoveryError } from './errors.js';

/** How many cases an overview counts. Beyond this it says so rather than guess. */
const OVERVIEW_LIMIT = 500;
import { assessRecovery, buildRepairPlan } from './repair.js';
import { budgetOf, canAttempt, clampLimits, exhaustionMessage } from './policy.js';
import type { RecoveryStore } from './store.js';
import {
  OPEN_CASE_STATUSES,
  RECOVERY_CASE_STATUSES,
  type RecoveryAction,
  type RecoveryCaseFilter,
  type RecoveryCaseRecord,
  type RecoveryDiagnosis,
  type RecoveryEscalation,
  type RecoveryEvent,
  type RecoveryEventType,
  type RecoveryLimits,
  type RecoveryOverview,
  type RecoveryCaseStatus,
  type RepairAttempt,
  type RepairAttemptOutcome,
  type RepairPlan,
  type FailureObservation,
  type VerificationSnapshot,
} from './types.js';

export interface RecoveryManagerOptions {
  readonly store: RecoveryStore;
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

const openStatus = (status: string): boolean =>
  (OPEN_CASE_STATUSES as readonly string[]).includes(status);

export class RecoveryManager {
  private readonly store: RecoveryStore;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(options: RecoveryManagerOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    let counter = 0;
    this.generateId =
      options.generateId ??
      (() => {
        counter += 1;
        return `rcv_${Date.now().toString(36)}${counter.toString(36)}`;
      });
  }

  /** Open a case for a failed or incomplete unit of work. */
  async detect(input: {
    readonly ownerRef: string;
    readonly observation: FailureObservation;
    readonly limits?: Partial<RecoveryLimits> | undefined;
  }): Promise<RecoveryCaseRecord> {
    const now = this.now();
    const at = now.toISOString();
    const diagnosis = diagnose(input.observation);
    const limits = clampLimits(input.limits);
    const id = this.generateId();

    const insufficient = diagnosis.insufficient;
    const record: RecoveryCaseRecord = {
      id,
      ownerRef: input.ownerRef,
      projectId: input.observation.projectId,
      taskId: input.observation.taskId,
      workerId: input.observation.workerId,
      workerType: input.observation.workerType,
      status: insufficient ? 'escalated' : 'open',
      diagnosis,
      observation: input.observation,
      limits,
      attempts: 0,
      reassignments: 0,
      modelCalls: 0,
      nextAttemptNotBefore: null,
      preservedChangeSets: [],
      stoppedReason: insufficient ? diagnosis.reason : null,
      escalation: insufficient
        ? {
            reason: 'insufficient_evidence',
            message: diagnosis.reason,
            attempted: [],
            remaining: diagnosis.affectedDeliverables,
            at,
          }
        : null,
      verification: null,
      revisionAtStart: input.observation.revision.atStart,
      revisionAtRecovery: null,
      createdAt: at,
      updatedAt: at,
      version: 1,
      eventSeq: 0,
    };

    const events: RecoveryEvent[] = [
      {
        caseId: id,
        seq: 1,
        type: 'failure_detected',
        at,
        actor: 'primary_agent',
        message: `Failure detected on task ${input.observation.taskId}: ${diagnosis.findings[0]?.detail ?? 'no signal'}.`,
        detail: { status: input.observation.workerStatus },
      },
      insufficient
        ? {
            caseId: id,
            seq: 2,
            type: 'diagnosis_declined',
            at,
            actor: 'primary_agent',
            message: diagnosis.reason,
          }
        : {
            caseId: id,
            seq: 2,
            type: 'diagnosed',
            at,
            actor: 'primary_agent',
            message: `${diagnosis.primary} (${diagnosis.classification}, ${diagnosis.confidence} confidence): ${diagnosis.likelyCause ?? ''}`,
            detail: { action: diagnosis.recommendedAction },
          },
      ...(insufficient
        ? [
            {
              caseId: id,
              seq: 3,
              type: 'escalated' as RecoveryEventType,
              at,
              actor: 'primary_agent' as const,
              message: 'Escalated: the evidence does not support a repair.',
            },
          ]
        : []),
    ];

    const withSeq: RecoveryCaseRecord = { ...record, eventSeq: events.length };
    await this.store.insertCase(withSeq, events);
    return withSeq;
  }

  async inspect(ownerRef: string, caseId: string): Promise<RecoveryCaseRecord> {
    const record = await this.store.readCase(ownerRef, caseId);
    if (record === null) {
      throw new RecoveryError('RECOVERY_CASE_NOT_FOUND', 'No such recovery case.', 404);
    }
    return record;
  }

  list(ownerRef: string, filter: RecoveryCaseFilter = {}): Promise<readonly RecoveryCaseRecord[]> {
    return this.store.listCases(ownerRef, filter);
  }

  /**
   * Counts over the owner's cases, for the operations dashboard. Nothing is
   * inferred: every figure is a tally of a stored field, and `truncated` says
   * when only the most recent records were counted.
   */
  async overview(ownerRef: string, filter: RecoveryCaseFilter = {}): Promise<RecoveryOverview> {
    const cases = await this.store.listCases(ownerRef, { ...filter, limit: OVERVIEW_LIMIT });
    const byStatus = Object.fromEntries(
      RECOVERY_CASE_STATUSES.map((status) => [status, 0]),
    ) as Record<RecoveryCaseStatus, number>;
    const byCategory: Record<string, number> = {};
    let insufficientEvidence = 0;
    let verificationFailed = 0;
    let attemptsUsed = 0;
    let attemptsRemaining = 0;

    for (const record of cases) {
      byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
      const category = record.diagnosis?.primary ?? null;
      if (category !== null) byCategory[category] = (byCategory[category] ?? 0) + 1;
      if (record.diagnosis === null || record.diagnosis.insufficient === true) {
        insufficientEvidence += 1;
      }
      const verification = record.verification;
      if (verification !== null && verification.executed && verification.status !== 'passed') {
        verificationFailed += 1;
      }
      attemptsUsed += record.attempts;
      if (OPEN_CASE_STATUSES.includes(record.status)) {
        attemptsRemaining += Math.max(record.limits.maxAttempts - record.attempts, 0);
      }
    }

    // A case that spent every attempt is exhausted whether it is still open or
    // has already been handed back for that reason.
    const exhausted = cases.filter(
      (record) =>
        record.attempts >= record.limits.maxAttempts &&
        (OPEN_CASE_STATUSES.includes(record.status) ||
          record.escalation?.reason === 'budget_exhausted'),
    ).length;

    return {
      total: cases.length,
      byStatus,
      byCategory,
      awaitingDiagnosis: byStatus.open ?? 0,
      repairing: byStatus.repairing ?? 0,
      awaitingVerification: byStatus.awaiting_verification ?? 0,
      recovered: byStatus.recovered ?? 0,
      needsIntervention: byStatus.escalated ?? 0,
      insufficientEvidence,
      verificationFailed,
      exhausted,
      attemptsUsed,
      attemptsRemaining,
      truncated: cases.length >= OVERVIEW_LIMIT,
      generatedAt: this.now().toISOString(),
    };
  }

  attempts(ownerRef: string, caseId: string): Promise<readonly RepairAttempt[]> {
    return this.store.attempts(ownerRef, caseId);
  }

  events(
    ownerRef: string,
    caseId: string,
    afterSeq = 0,
    limit = 100,
  ): Promise<readonly RecoveryEvent[]> {
    return this.store.events(ownerRef, caseId, afterSeq, limit);
  }

  /** Re-diagnose from the stored observation, e.g. after new evidence arrives. */
  async reanalyse(
    ownerRef: string,
    caseId: string,
    observation?: FailureObservation,
  ): Promise<RecoveryCaseRecord> {
    const record = await this.inspect(ownerRef, caseId);
    if (!openStatus(record.status)) {
      return record;
    }
    const next = diagnose(observation ?? record.observation);
    const at = this.now().toISOString();
    const events: RecoveryEvent[] = [
      {
        caseId,
        seq: record.eventSeq + 1,
        type: next.insufficient ? 'diagnosis_declined' : 'diagnosed',
        at,
        actor: 'primary_agent',
        message: next.insufficient
          ? next.reason
          : `${next.primary} (${next.classification}, ${next.confidence} confidence)`,
      },
    ];
    const updated: RecoveryCaseRecord = {
      ...record,
      diagnosis: next,
      observation: observation ?? record.observation,
      updatedAt: at,
      version: record.version + 1,
      eventSeq: record.eventSeq + events.length,
    };
    await this.save(updated, record.version, events);
    return updated;
  }

  /**
   * Plan the next bounded attempt, or refuse with the reason. Refusals are
   * errors so a caller cannot accidentally proceed with a plan that was denied.
   */
  async plan(
    ownerRef: string,
    caseId: string,
    options: { readonly currentRevision?: string | null } = {},
  ): Promise<RepairPlan> {
    const record = await this.inspect(ownerRef, caseId);
    const active = await this.store.activeAttempts(ownerRef, record.taskId);
    const decision = canAttempt({
      record,
      diagnosis: record.diagnosis,
      now: this.now(),
      activeRepairs: active,
    });
    if (!decision.allowed) {
      throw this.rejection(decision.rejection, decision.reason);
    }
    if (
      options.currentRevision !== undefined &&
      options.currentRevision !== null &&
      record.observation.revision.now !== null &&
      options.currentRevision !== record.observation.revision.now
    ) {
      throw new RecoveryError(
        'RECOVERY_STALE_REVISION',
        `The project moved to ${options.currentRevision} since the failure was recorded (${record.observation.revision.now}); re-read it before repairing.`,
        409,
      );
    }
    const diagnosis = record.diagnosis as RecoveryDiagnosis;
    const plan = buildRepairPlan({
      diagnosis,
      observation: record.observation,
      attempt: record.attempts + 1,
      limits: record.limits,
    });

    const at = this.now().toISOString();
    const events: RecoveryEvent[] = [
      {
        caseId,
        seq: record.eventSeq + 1,
        type: 'repair_planned',
        at,
        actor: 'primary_agent',
        message: `${plan.action} for ${plan.workerType}: ${plan.objective}`,
        detail: { deliverables: plan.deliverables.map((item) => item.name) },
      },
    ];
    const updated: RecoveryCaseRecord = {
      ...record,
      status: 'repairing',
      updatedAt: at,
      version: record.version + 1,
      eventSeq: record.eventSeq + events.length,
      nextAttemptNotBefore:
        decision.waitedMs > 0
          ? new Date(this.now().getTime() + decision.waitedMs).toISOString()
          : null,
    };
    await this.save(updated, record.version, events);
    return plan;
  }

  /** Record that a repair worker has actually been created and started. */
  async startAttempt(input: {
    readonly ownerRef: string;
    readonly caseId: string;
    readonly action: RecoveryAction;
    readonly workerId: string | null;
    readonly workerType: string | null;
    readonly waitedMs?: number;
  }): Promise<{ readonly record: RecoveryCaseRecord; readonly attempt: RepairAttempt }> {
    const record = await this.inspect(input.ownerRef, input.caseId);
    if (!openStatus(record.status)) {
      throw new RecoveryError(
        'RECOVERY_CASE_CLOSED',
        `The case is ${record.status}; no attempt may start.`,
        409,
      );
    }
    const existing = await this.store.attempts(input.ownerRef, input.caseId);
    // Idempotency: the same worker starting twice for one case is a bug, not work.
    if (
      input.workerId !== null &&
      existing.some(
        (attempt) => attempt.workerId === input.workerId && attempt.outcome === 'running',
      )
    ) {
      throw new RecoveryError(
        'RECOVERY_DUPLICATE_ATTEMPT',
        'That repair worker is already recorded as running for this case.',
        409,
      );
    }
    if (existing.some((attempt) => attempt.outcome === 'running')) {
      throw new RecoveryError(
        'RECOVERY_DUPLICATE_ATTEMPT',
        'A repair attempt is already running for this case.',
        409,
      );
    }

    const at = this.now().toISOString();
    const attempt: RepairAttempt = {
      id: this.generateId(),
      ownerRef: input.ownerRef,
      caseId: input.caseId,
      attempt: record.attempts + 1,
      action: input.action,
      workerId: input.workerId,
      workerType: input.workerType,
      startedAt: at,
      endedAt: null,
      outcome: 'running',
      summary: null,
      verificationRunId: null,
      changeSetId: null,
      waitedMs: input.waitedMs ?? 0,
    };
    await this.store.insertAttempt(attempt);

    // A reassignment is work moving to a DIFFERENT kind of Superagent, not a
    // fresh instance of the same kind. Retrying with another testing worker is
    // a retry; handing the work from backend to testing is a reassignment. The
    // distinction matters because the reassignment budget is small and must not
    // be spent by ordinary retries.
    const settled = existing.filter((item) => item.outcome !== 'running');
    const previousAttempt = settled.length === 0 ? null : settled[settled.length - 1];
    const previousType = previousAttempt?.workerType ?? record.observation.workerType;
    const previousWorker = previousAttempt?.workerId ?? record.observation.workerId;
    const reassigned =
      previousType !== null &&
      input.workerType !== previousType &&
      input.workerId !== previousWorker;
    const events: RecoveryEvent[] = [
      {
        caseId: input.caseId,
        seq: record.eventSeq + 1,
        type: 'repair_started',
        at,
        actor: 'primary_agent',
        message: `Repair attempt ${attempt.attempt} started (${input.action}).`,
        detail: { workerId: input.workerId, workerType: input.workerType },
      },
      ...(reassigned
        ? [
            {
              caseId: input.caseId,
              seq: record.eventSeq + 2,
              type: 'reassigned' as RecoveryEventType,
              at,
              actor: 'primary_agent' as const,
              message: `Work moved from ${record.observation.workerId} to ${input.workerId ?? 'a new worker'}.`,
            },
          ]
        : []),
    ];
    const updated: RecoveryCaseRecord = {
      ...record,
      status: 'repairing',
      attempts: attempt.attempt,
      reassignments: record.reassignments + (reassigned ? 1 : 0),
      updatedAt: at,
      version: record.version + 1,
      eventSeq: record.eventSeq + events.length,
    };
    await this.save(updated, record.version, events);
    return { record: updated, attempt };
  }

  /**
   * Attach stored evidence to a case whose attempt already reported success
   * without proving it. Nothing is concluded on the claim: if the run did not
   * execute and pass, the case is left exactly as it was and the refusal says
   * what is missing.
   */
  async recordEvidence(input: {
    readonly ownerRef: string;
    readonly caseId: string;
    readonly verification: VerificationSnapshot;
    readonly changeSetId?: string | null;
    readonly integrated?: boolean;
    readonly summary?: string | null;
    readonly currentRevision?: string | null;
  }): Promise<{
    readonly record: RecoveryCaseRecord;
    readonly recovered: boolean;
    readonly reason: string;
  }> {
    const record = await this.inspect(input.ownerRef, input.caseId);
    if (record.status === 'recovered') {
      throw new RecoveryError(
        'RECOVERY_CASE_CLOSED',
        'That case is already recorded as recovered; its evidence does not change.',
        409,
      );
    }
    if (!OPEN_CASE_STATUSES.includes(record.status)) {
      throw new RecoveryError(
        'RECOVERY_CASE_CLOSED',
        'That case is no longer open, so new evidence cannot close it.',
        409,
      );
    }
    const verdict = assessRecovery({
      verification: input.verification,
      changeSetId: input.changeSetId ?? null,
      integrated: input.integrated === true,
      notes: [],
    });
    if (!verdict.recovered) {
      throw new RecoveryError('RECOVERY_VERIFICATION_REQUIRED', verdict.reason, 409);
    }
    const at = this.now().toISOString();
    const events: RecoveryEvent[] = [
      {
        caseId: input.caseId,
        seq: record.eventSeq + 1,
        type: 'verification_recorded',
        at,
        actor: 'primary_agent',
        message: input.summary ?? `Verification run ${input.verification.runId} passed.`,
        detail: { verificationRunId: input.verification.runId },
      },
      {
        caseId: input.caseId,
        seq: record.eventSeq + 2,
        type: 'recovered',
        at,
        actor: 'primary_agent',
        message: verdict.reason,
      },
    ];
    const updated: RecoveryCaseRecord = {
      ...record,
      status: 'recovered',
      verification: input.verification,
      stoppedReason: null,
      revisionAtRecovery: input.currentRevision ?? record.observation.revision.now,
      updatedAt: at,
      version: record.version + 1,
      eventSeq: record.eventSeq + events.length,
    };
    await this.save(updated, record.version, events);
    return { record: updated, recovered: true, reason: verdict.reason };
  }

  /**
   * Record what an attempt produced. Recovery is only concluded from evidence:
   * a claimed success without an executed passing run stays awaiting
   * verification, and once the budget is gone the case escalates.
   */
  async finishAttempt(input: {
    readonly ownerRef: string;
    readonly caseId: string;
    readonly attemptId: string;
    readonly outcome: RepairAttemptOutcome;
    readonly summary: string | null;
    readonly verification?: VerificationSnapshot | null;
    readonly changeSetId?: string | null;
    readonly integrated?: boolean;
    readonly modelCalls?: number;
    readonly currentRevision?: string | null;
  }): Promise<{
    readonly record: RecoveryCaseRecord;
    readonly recovered: boolean;
    readonly reason: string;
  }> {
    const record = await this.inspect(input.ownerRef, input.caseId);
    const attempts = await this.store.attempts(input.ownerRef, input.caseId);
    const attempt = attempts.find((item) => item.id === input.attemptId);
    if (attempt === undefined) {
      throw new RecoveryError('RECOVERY_INPUT_INVALID', 'No such repair attempt.', 400);
    }
    if (attempt.outcome !== 'running') {
      throw new RecoveryError(
        'RECOVERY_DUPLICATE_ATTEMPT',
        `Attempt ${attempt.attempt} is already recorded as ${attempt.outcome}.`,
        409,
      );
    }

    const now = this.now();
    const at = now.toISOString();
    const verification = input.verification ?? null;
    const verdict =
      input.outcome === 'succeeded'
        ? assessRecovery({
            verification,
            changeSetId: input.changeSetId ?? null,
            integrated: input.integrated === true,
            notes: [],
          })
        : {
            recovered: false,
            reason: `The attempt ${input.outcome.replace('_', ' ')}.`,
            missing: [],
          };

    const finishedAttempt: RepairAttempt = {
      ...attempt,
      endedAt: at,
      outcome: input.outcome,
      summary: input.summary,
      verificationRunId: verification?.runId ?? null,
      changeSetId: input.changeSetId ?? null,
    };
    await this.store.saveAttempt(finishedAttempt);

    const nextAttempts = record.attempts;
    const provisional: RecoveryCaseRecord = {
      ...record,
      modelCalls: record.modelCalls + (input.modelCalls ?? 0),
      verification: verification ?? record.verification,
      updatedAt: at,
    };
    const budget = budgetOf(provisional, now);

    let stoppedReason = record.stoppedReason;
    let escalation = record.escalation;
    let revisionAtRecovery = record.revisionAtRecovery;
    let nextAttemptNotBefore = provisional.nextAttemptNotBefore;
    // Every branch below sets the status; the current value is the default only
    // when a future branch does not, so it is kept rather than removed.
    // eslint-disable-next-line no-useless-assignment
    let status = record.status;
    const events: RecoveryEvent[] = [
      {
        caseId: input.caseId,
        seq: record.eventSeq + 1,
        type: 'repair_reported',
        at,
        actor: 'primary_agent',
        message: `Attempt ${attempt.attempt} ${input.outcome}: ${input.summary ?? 'no summary'}.`,
        detail: { verificationRunId: verification?.runId ?? null },
      },
    ];

    if (verdict.recovered) {
      status = 'recovered';
      revisionAtRecovery = input.currentRevision ?? record.observation.revision.now;
      events.push({
        caseId: input.caseId,
        seq: record.eventSeq + 2,
        type: 'recovered',
        at,
        actor: 'primary_agent',
        message: verdict.reason,
      });
    } else if (input.outcome === 'succeeded') {
      // Claimed success without proof: keep the case open, say what is missing.
      status = 'awaiting_verification';
      stoppedReason = verdict.reason;
      events.push({
        caseId: input.caseId,
        seq: record.eventSeq + 2,
        type: 'verification_recorded',
        at,
        actor: 'primary_agent',
        message: verdict.reason,
        detail: { missing: verdict.missing },
      });
      if (budget.exhaustedBy !== null) {
        status = 'escalated';
        stoppedReason = `${verdict.reason} ${exhaustionMessage(provisional)}`;
        escalation = this.escalationFor(provisional, 'budget_exhausted', stoppedReason, attempts);
        events.push({
          caseId: input.caseId,
          seq: record.eventSeq + 3,
          type: 'budget_exhausted',
          at,
          actor: 'primary_agent',
          message: stoppedReason,
        });
      }
    } else {
      status = budget.exhaustedBy !== null ? 'escalated' : 'repairing';
      if (budget.exhaustedBy !== null) {
        stoppedReason = exhaustionMessage(provisional);
        escalation = this.escalationFor(provisional, 'budget_exhausted', stoppedReason, attempts);
        events.push({
          caseId: input.caseId,
          seq: record.eventSeq + 2,
          type: 'budget_exhausted',
          at,
          actor: 'primary_agent',
          message: stoppedReason,
        });
      } else {
        const wait = clampLimits(record.limits);
        // Backoff for the *next* attempt: doubling from the configured base.
        const backoffMs = Math.min(
          wait.backoffBaseMs * 2 ** Math.max(0, nextAttempts - 1),
          wait.backoffCeilingMs,
        );
        nextAttemptNotBefore = new Date(now.getTime() + backoffMs).toISOString();
      }
    }

    const updated: RecoveryCaseRecord = {
      ...provisional,
      status,
      stoppedReason,
      nextAttemptNotBefore,
      escalation,
      revisionAtRecovery,
      version: record.version + 1,
      eventSeq: record.eventSeq + events.length,
    };
    await this.save(updated, record.version, events);
    return { record: updated, recovered: verdict.recovered, reason: verdict.reason };
  }

  /** Keep an accepted change set safe: it is never reverted by a repair. */
  async preserve(
    ownerRef: string,
    caseId: string,
    changeSetId: string,
  ): Promise<RecoveryCaseRecord> {
    const record = await this.inspect(ownerRef, caseId);
    if (record.preservedChangeSets.includes(changeSetId)) return record;
    const at = this.now().toISOString();
    const events: RecoveryEvent[] = [
      {
        caseId,
        seq: record.eventSeq + 1,
        type: 'state_rejected',
        at,
        actor: 'primary_agent',
        message: `Preserved accepted change set ${changeSetId}; it is outside the repair's reach.`,
      },
    ];
    const updated: RecoveryCaseRecord = {
      ...record,
      preservedChangeSets: [...record.preservedChangeSets, changeSetId],
      updatedAt: at,
      version: record.version + 1,
      eventSeq: record.eventSeq + events.length,
    };
    await this.save(updated, record.version, events);
    return updated;
  }

  /** Stop automatic work and hand the case to the owner, with the reasons. */
  async escalate(input: {
    readonly ownerRef: string;
    readonly caseId: string;
    readonly reason: RecoveryEscalation['reason'];
    readonly message: string;
  }): Promise<RecoveryCaseRecord> {
    const record = await this.inspect(input.ownerRef, input.caseId);
    if (record.status === 'recovered') {
      throw new RecoveryError('RECOVERY_CASE_CLOSED', 'A recovered case cannot be escalated.', 409);
    }
    const attempts = await this.store.attempts(input.ownerRef, input.caseId);
    const at = this.now().toISOString();
    const escalation = this.escalationFor(record, input.reason, input.message, attempts);
    const events: RecoveryEvent[] = [
      {
        caseId: input.caseId,
        seq: record.eventSeq + 1,
        type: 'escalated',
        at,
        actor: 'primary_agent',
        message: input.message,
        detail: { reason: input.reason },
      },
    ];
    const updated: RecoveryCaseRecord = {
      ...record,
      status: 'escalated',
      escalation,
      stoppedReason: input.message,
      updatedAt: at,
      version: record.version + 1,
      eventSeq: record.eventSeq + events.length,
    };
    await this.save(updated, record.version, events);
    return updated;
  }

  async cancel(ownerRef: string, caseId: string, message: string): Promise<RecoveryCaseRecord> {
    const record = await this.inspect(ownerRef, caseId);
    if (record.status === 'cancelled') return record;
    const at = this.now().toISOString();
    const events: RecoveryEvent[] = [
      {
        caseId,
        seq: record.eventSeq + 1,
        type: 'cancelled',
        at,
        actor: 'primary_agent',
        message,
      },
    ];
    const updated: RecoveryCaseRecord = {
      ...record,
      status: 'cancelled',
      stoppedReason: message,
      updatedAt: at,
      version: record.version + 1,
      eventSeq: record.eventSeq + events.length,
    };
    await this.save(updated, record.version, events);
    return updated;
  }

  /**
   * Restart recovery. A case whose attempts were running when the process died
   * has no live worker: those attempts are recorded as abandoned, the revision
   * is revalidated, and the case becomes plannable again only if the budget and
   * evidence still allow it. Nothing is resumed twice.
   */
  async resume(input: {
    readonly ownerRef: string;
    readonly caseId: string;
    readonly currentRevision?: string | null;
    readonly now?: Date;
  }): Promise<RecoveryCaseRecord> {
    const record = await this.inspect(input.ownerRef, input.caseId);
    if (!openStatus(record.status)) return record;
    const attempts = await this.store.attempts(input.ownerRef, input.caseId);
    const running = attempts.filter((attempt) => attempt.outcome === 'running');
    const at = (input.now ?? this.now()).toISOString();
    const events: RecoveryEvent[] = [
      {
        caseId: input.caseId,
        seq: record.eventSeq + 1,
        type: 'resumed',
        at,
        actor: 'system',
        message: `Recovered case state after restart; ${running.length} in-flight attempt(s) marked abandoned.`,
      },
    ];
    for (const attempt of running) {
      await this.store.saveAttempt({
        ...attempt,
        outcome: 'abandoned',
        endedAt: at,
        summary: 'The process stopped while this attempt was running; no result was recorded.',
      });
    }

    const moved =
      input.currentRevision !== undefined &&
      input.currentRevision !== null &&
      record.observation.revision.now !== null &&
      input.currentRevision !== record.observation.revision.now;

    let status = record.status;
    const stoppedReason = record.stoppedReason;
    if (moved) {
      events.push({
        caseId: input.caseId,
        seq: record.eventSeq + 2,
        type: 'state_rejected',
        at,
        actor: 'system',
        message: `The project moved to ${input.currentRevision}; the repair is replanned against the new revision.`,
      });
      status = 'open';
    }
    const updated: RecoveryCaseRecord = {
      ...record,
      status,
      stoppedReason,
      observation: moved
        ? {
            ...record.observation,
            revision: { ...record.observation.revision, now: input.currentRevision ?? null },
          }
        : record.observation,
      updatedAt: at,
      version: record.version + 1,
      eventSeq: record.eventSeq + events.length,
    };
    await this.save(updated, record.version, events);
    return updated;
  }

  private escalationFor(
    record: RecoveryCaseRecord,
    reason: RecoveryEscalation['reason'],
    message: string,
    attempts: readonly RepairAttempt[],
  ): RecoveryEscalation {
    return {
      reason,
      message,
      attempted: attempts.map(
        (attempt) =>
          `attempt ${attempt.attempt} (${attempt.action}, ${attempt.workerType ?? 'unknown type'}): ${attempt.outcome}${
            attempt.summary === null ? '' : ` — ${attempt.summary}`
          }`,
      ),
      remaining: record.diagnosis === null ? [] : [...record.diagnosis.affectedDeliverables],
      at: this.now().toISOString(),
    };
  }

  private rejection(rejection: string | null, reason: string): RecoveryError {
    switch (rejection) {
      case 'insufficient_evidence':
        return new RecoveryError('RECOVERY_DIAGNOSIS_INSUFFICIENT', reason, 409);
      case 'policy_refusal':
        return new RecoveryError('RECOVERY_POLICY_REFUSAL', reason, 409);
      case 'needs_human':
        return new RecoveryError('RECOVERY_NEEDS_HUMAN', reason, 409);
      case 'budget_exhausted':
        return new RecoveryError('RECOVERY_BUDGET_EXHAUSTED', reason, 409);
      case 'backoff_waiting':
        return new RecoveryError('RECOVERY_BACKOFF_ACTIVE', reason, 409);
      case 'concurrency_limit':
        return new RecoveryError('RECOVERY_CONCURRENCY_LIMIT', reason, 409);
      case 'case_closed':
        return new RecoveryError('RECOVERY_CASE_CLOSED', reason, 409);
      default:
        return new RecoveryError('RECOVERY_INPUT_INVALID', reason, 400);
    }
  }

  private async save(
    record: RecoveryCaseRecord,
    expectedVersion: number,
    events: readonly RecoveryEvent[],
  ): Promise<void> {
    const saved = await this.store.saveCase(record, expectedVersion, events);
    if (!saved) {
      throw new RecoveryError(
        'RECOVERY_STATE_CONFLICT',
        'The case changed while this update was being written; re-read and retry.',
        409,
      );
    }
  }
}
