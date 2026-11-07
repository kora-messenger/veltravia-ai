/**
 * Autonomous repair vocabulary.
 *
 * Three things are deliberately separated here, because conflating them is how
 * a recovery system starts lying:
 *
 *  - the **finding**: what is observable about a failed or incomplete unit of
 *    work, always carrying the evidence that produced it;
 *  - the **classification**: whether the failure is temporary, permanent, a
 *    policy refusal, or something only a human can settle;
 *  - the **diagnosis**: the Primary Agent's reasoned next step, which is only
 *    allowed to exist when the evidence supports it.
 *
 * Nothing in this file grants permission. A repair assignment is built as a
 * *subset* of the failed assignment, and the manager refuses anything wider.
 */

export const FAILURE_CATEGORIES = [
  'worker_crash',
  'timeout',
  'cancelled',
  'missing_deliverables',
  'incomplete_changes',
  'failed_tests',
  'type_errors',
  'lint_failures',
  'build_failures',
  'invalid_tool_call',
  'permission_refused',
  'stale_revision',
  'change_conflict',
  'incompatible_output',
  'repeated_attempts',
  'unverified_completion',
  'unknown',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/**
 * `temporary` may be retried with backoff. `permanent` needs different work,
 * not another identical attempt. `policy` is a refusal: repeating it is abuse.
 * `needs_human` is a decision the Primary Agent may not make on its own.
 */
export const FAILURE_CLASSES = ['temporary', 'permanent', 'policy', 'needs_human'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const RECOVERY_ACTIONS = [
  'retry_same_worker',
  'reassign_worker',
  'split_work',
  'request_specialist',
  'run_verification',
  'rollback_integration',
  'escalate_user',
  'mark_blocked',
] as const;

export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];

export const RECOVERY_CASE_STATUSES = [
  'open',
  'diagnosing',
  'repairing',
  'awaiting_verification',
  'recovered',
  'escalated',
  'blocked',
  'cancelled',
] as const;

export type RecoveryCaseStatus = (typeof RECOVERY_CASE_STATUSES)[number];

/** Statuses where the case still owns work. */
export const OPEN_CASE_STATUSES: readonly RecoveryCaseStatus[] = [
  'open',
  'diagnosing',
  'repairing',
  'awaiting_verification',
];

export type Confidence = 'high' | 'medium' | 'low' | 'insufficient';

/** One observable fact, with where it came from. Evidence is never invented. */
export interface FailureEvidence {
  readonly kind:
    | 'worker_record'
    | 'worker_failure'
    | 'worker_result'
    | 'review'
    | 'verification'
    | 'change_set'
    | 'conflict'
    | 'tool_error'
    | 'revision'
    | 'attempt_history';
  readonly ref: string;
  readonly detail: string;
}

export interface FailureFinding {
  readonly category: FailureCategory;
  readonly classification: FailureClass;
  /** One sentence a person can act on. */
  readonly detail: string;
  readonly evidence: readonly FailureEvidence[];
}

/** A verdict recorded by Step 45, reduced to what recovery needs. */
export interface VerificationSnapshot {
  readonly runId: string;
  readonly status: 'passed' | 'failed' | 'incomplete' | 'blocked' | 'cancelled';
  /** False when no command actually ran, so nothing was proven. */
  readonly executed: boolean;
  readonly executedCount: number;
  readonly failedOperations: readonly string[];
  readonly evidence: readonly FailureEvidence[];
}

export interface ConflictSnapshot {
  readonly changeSetId: string;
  readonly kinds: readonly string[];
  readonly detail: string;
}

export interface ToolFailure {
  readonly tool: string;
  readonly code: string;
  readonly message: string;
  /** True when the server refused for permission or policy, not for a bug. */
  readonly refused: boolean;
}

/**
 * What the coordinator is told. This is deliberately a flat observation rather
 * than a live worker object: recovery must be able to run from persisted state
 * after a restart, when no worker object exists any more.
 */
export interface FailureObservation {
  readonly projectId: string;
  readonly taskId: string;
  readonly workerId: string | null;
  /** The worker's type when it was assigned, so a repair can pick a peer. */
  readonly workerType: string | null;
  readonly workerStatus:
    | 'failed'
    | 'timed_out'
    | 'cancelled'
    | 'blocked'
    | 'partially_completed'
    | 'awaiting_review'
    | 'completed'
    | 'queued'
    | 'running';
  readonly failure: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
  readonly declaration: {
    readonly deliverables: readonly string[];
    readonly acceptanceCriteria: readonly string[];
    readonly scope: readonly string[];
    readonly allowedTools: readonly string[];
    readonly permissions: {
      readonly readProject: boolean;
      readonly writeProject: boolean;
      readonly runTools: boolean;
      readonly network: boolean;
    };
    readonly limits: {
      readonly maxDurationMs: number;
      readonly maxToolCalls: number;
      readonly maxDeliverables: number;
    };
    /**
     * The failed worker's behavioural constraints. A repair inherits these:
     * they say how work is reported, not what it is allowed to reach, so they
     * are copied rather than re-derived.
     */
    readonly checkpoints?: readonly string[];
    readonly cancellationConditions?: readonly string[];
    readonly reporting?: readonly string[];
  };
  readonly produced: {
    readonly deliverables: readonly string[];
    readonly criteriaMet: number | null;
    readonly summary: string | null;
    readonly simulated: boolean;
  };
  readonly attempts: number;
  readonly reviewRefusals: readonly string[];
  readonly verification: VerificationSnapshot | null;
  readonly conflicts: readonly ConflictSnapshot[];
  readonly toolErrors: readonly ToolFailure[];
  readonly revision: { readonly atStart: string | null; readonly now: string | null };
  /** Messages from previous repair attempts, oldest first. */
  readonly previousAttempts: readonly string[];
}

export interface RecoveryDiagnosis {
  readonly primary: FailureCategory | null;
  readonly classification: FailureClass | null;
  readonly findings: readonly FailureFinding[];
  readonly likelyCause: string | null;
  readonly affectedDeliverables: readonly string[];
  readonly recommendedAction: RecoveryAction | null;
  readonly requiredPermissions: readonly string[];
  readonly confidence: Confidence;
  /** Why this conclusion, or why none could be reached. */
  readonly reason: string;
  readonly evidence: readonly FailureEvidence[];
  /** True when the engine declined to diagnose. */
  readonly insufficient: boolean;
}

export interface RecoveryLimits {
  readonly maxAttempts: number;
  readonly maxTotalDurationMs: number;
  readonly maxReassignments: number;
  readonly maxModelCalls: number;
  readonly maxConcurrentRepairs: number;
  readonly backoffBaseMs: number;
  readonly backoffCeilingMs: number;
}

export const DEFAULT_RECOVERY_LIMITS: RecoveryLimits = {
  maxAttempts: 3,
  maxTotalDurationMs: 45 * 60_000,
  maxReassignments: 2,
  maxModelCalls: 60,
  maxConcurrentRepairs: 2,
  backoffBaseMs: 15_000,
  backoffCeilingMs: 5 * 60_000,
};

/** Ceilings the API clamps to; a caller cannot widen these. */
export const HARD_RECOVERY_LIMITS: RecoveryLimits = {
  maxAttempts: 5,
  maxTotalDurationMs: 2 * 60 * 60_000,
  maxReassignments: 3,
  maxModelCalls: 300,
  maxConcurrentRepairs: 4,
  backoffBaseMs: 60_000,
  backoffCeilingMs: 15 * 60_000,
};

export const RECOVERY_EVENT_TYPES = [
  'failure_detected',
  'diagnosed',
  'diagnosis_declined',
  'repair_planned',
  'repair_started',
  'repair_reported',
  'verification_recorded',
  'recovered',
  'retry_scheduled',
  'reassigned',
  'rolled_back',
  'escalated',
  'blocked',
  'cancelled',
  'resumed',
  'budget_exhausted',
  'state_rejected',
] as const;

export type RecoveryEventType = (typeof RECOVERY_EVENT_TYPES)[number];

export interface RecoveryEvent {
  readonly caseId: string;
  readonly seq: number;
  readonly type: RecoveryEventType;
  readonly at: string;
  readonly actor: 'primary_agent' | 'system';
  readonly message: string;
  readonly detail?: Record<string, unknown>;
}

export const REPAIR_ATTEMPT_OUTCOMES = [
  'running',
  'succeeded',
  'failed',
  'refused',
  'timed_out',
  'cancelled',
  'abandoned',
] as const;

export type RepairAttemptOutcome = (typeof REPAIR_ATTEMPT_OUTCOMES)[number];

export interface RepairAttempt {
  readonly id: string;
  readonly ownerRef: string;
  readonly caseId: string;
  readonly attempt: number;
  readonly action: RecoveryAction;
  readonly workerId: string | null;
  readonly workerType: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: RepairAttemptOutcome;
  readonly summary: string | null;
  readonly verificationRunId: string | null;
  readonly changeSetId: string | null;
  /** Backoff applied before this attempt, for the audit trail. */
  readonly waitedMs: number;
}

export interface RecoveryCaseRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly workerId: string | null;
  /** The worker's type when it was assigned, so a repair can pick a peer. */
  readonly workerType: string | null;
  readonly status: RecoveryCaseStatus;
  readonly diagnosis: RecoveryDiagnosis | null;
  readonly observation: FailureObservation;
  readonly limits: RecoveryLimits;
  readonly attempts: number;
  readonly reassignments: number;
  readonly modelCalls: number;
  /** Attempts cannot start before this; set by backoff. */
  readonly nextAttemptNotBefore: string | null;
  /** Accepted change sets that must survive any repair. */
  readonly preservedChangeSets: readonly string[];
  /** Why the case stopped, in plain words, when it is not recovered. */
  readonly stoppedReason: string | null;
  readonly escalation: RecoveryEscalation | null;
  readonly verification: VerificationSnapshot | null;
  readonly revisionAtStart: string | null;
  readonly revisionAtRecovery: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly eventSeq: number;
}

export interface RecoveryEscalation {
  readonly reason:
    | 'budget_exhausted'
    | 'needs_human'
    | 'policy_refusal'
    | 'unsafe_recovery'
    | 'cancelled_by_user'
    | 'insufficient_evidence'
    | 'conflicting_changes';
  readonly message: string;
  /** What was attempted, oldest first. */
  readonly attempted: readonly string[];
  /** What is still not done. */
  readonly remaining: readonly string[];
  readonly at: string;
}

export interface RecoveryCaseFilter {
  readonly projectId?: string;
  readonly taskId?: string;
  readonly status?: readonly RecoveryCaseStatus[];
  readonly openOnly?: boolean;
  readonly limit?: number;
}

/** A bounded repair assignment. Every field is derived, never invented. */
export interface RepairPlan {
  readonly action: RecoveryAction;
  readonly workerType: string;
  readonly objective: string;
  readonly scope: readonly string[];
  readonly exclusions: readonly string[];
  readonly deliverables: readonly {
    readonly name: string;
    readonly kind: 'file' | 'patch' | 'report' | 'artifact' | 'notes';
    readonly path: string | null;
    readonly summary: string;
  }[];
  readonly acceptanceCriteria: readonly string[];
  readonly allowedTools: readonly string[];
  readonly permissions: FailureObservation['declaration']['permissions'];
  readonly limits: {
    readonly maxDurationMs: number;
    readonly maxToolCalls: number;
    readonly maxDeliverables: number;
  };
  /** Inherited behavioural constraints, copied from the failed assignment. */
  readonly checkpoints: readonly string[];
  readonly cancellationConditions: readonly string[];
  readonly reporting: readonly string[];
  readonly verification: { readonly operations: readonly string[] } | null;
  readonly requiredPermissions: readonly string[];
  /** Why this shape: shown to the user rather than left implicit. */
  readonly rationale: string;
}
