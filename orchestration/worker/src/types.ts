/**
 * Bounded Superagent worker vocabulary.
 *
 * A worker is not an agent with its own judgement. It is a bounded execution
 * slot: one task, one assignment, one set of allowed tools, one time budget,
 * and a result that the Primary Agent reviews. Nothing in this file lets a
 * worker widen what it was given.
 */

export const WORKER_STATUSES = [
  'queued',
  'assigned',
  'starting',
  'running',
  'blocked',
  'partially_completed',
  'awaiting_review',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const;

export type WorkerStatus = (typeof WORKER_STATUSES)[number];

/** Statuses whose worker is holding a slot: it exists, is not finished. */
export const ACTIVE_WORKER_STATUSES = [
  'queued',
  'assigned',
  'starting',
  'running',
  'blocked',
  'partially_completed',
  'awaiting_review',
] as const;

export const TERMINAL_WORKER_STATUSES = ['completed', 'failed', 'cancelled', 'timed_out'] as const;

export const WORKER_TYPES = [
  'frontend',
  'backend',
  'database',
  'testing',
  'documentation',
  'analysis',
  'ui',
  'security',
  'research',
  'review',
  'performance',
  'general',
] as const;

export type WorkerType = (typeof WORKER_TYPES)[number];

/** What a worker may claim to have produced. */
export const DELIVERABLE_KINDS = ['file', 'patch', 'report', 'artifact', 'notes'] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export interface Deliverable {
  readonly name: string;
  readonly kind: DeliverableKind;
  /** Project-relative path for file/patch deliverables; null otherwise. */
  readonly path: string | null;
  readonly summary: string;
  /** Content hash when the deliverable is a file the caller can re-check. */
  readonly hash?: string | null;
}

export const EVIDENCE_KINDS = ['test_run', 'command', 'file', 'note'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface WorkerEvidence {
  readonly kind: EvidenceKind;
  readonly ref: string;
  readonly summary: string;
  /** Set for a test or command: did it pass? null when it does not apply. */
  readonly passed?: boolean | null;
}

/** A path or resource a worker may write. Two overlapping claims conflict. */
export interface ResourceClaim {
  readonly kind: 'file' | 'directory';
  readonly path: string;
}

export interface WorkerLimits {
  /** Wall-clock ceiling for one execution. */
  readonly maxDurationMs: number;
  /** Tool calls the worker may make. Enforced by the executor. */
  readonly maxToolCalls: number;
  /** Files it may write, counted from its deliverables. */
  readonly maxDeliverables: number;
}

export interface WorkerVerificationScope {
  readonly operations: readonly string[];
}

export interface WorkerPermissions {
  readonly readProject: boolean;
  readonly writeProject: boolean;
  readonly runTools: boolean;
  readonly network: boolean;
}

/**
 * The assignment. This is the whole of what a worker knows and may do, and it
 * is stored with the worker so a review can compare the result against it
 * rather than against the worker's own account of what it was asked.
 */
export interface WorkerAssignment {
  readonly objective: string;
  /** Project paths the worker is expected to work in. */
  readonly scope: readonly string[];
  /** Explicit exclusions: what it must not touch even inside its scope. */
  readonly exclusions: readonly string[];
  readonly deliverables: readonly Deliverable[];
  readonly acceptanceCriteria: readonly string[];
  readonly allowedTools: readonly string[];
  readonly permissions: WorkerPermissions;
  /**
   * Verification operations this worker may run through `tests.run`. Omitted
   * means the default scope in `verification.ts`, never "everything".
   */
  readonly verification?: WorkerVerificationScope | null;
  readonly limits: WorkerLimits;
  readonly dependencies: readonly string[];
  readonly checkpoints: readonly string[];
  readonly cancellationConditions: readonly string[];
  readonly reporting: readonly string[];
  /** Primary-run id the work belongs to, when the caller has one. */
  readonly primaryRunId: string | null;
}

export interface WorkerFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly at: string;
}

export interface WorkerResult {
  readonly summary: string;
  readonly deliverables: readonly Deliverable[];
  readonly evidence: readonly WorkerEvidence[];
  readonly notes: string | null;
  readonly finishedAt: string;
  /** True when the executor that produced this result is a simulation. */
  readonly simulated: boolean;
  /** Provider, model and spend, when a model actually ran. */
  readonly usage?: WorkerUsageRecord | null;
}

/** What one worker's execution cost. Secrets are never part of this. */
export interface WorkerUsageRecord {
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** True only when a real provider answered over the network. */
  readonly live: boolean;
}

export interface ReviewCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export type ReviewDecision = 'accept' | 'reject' | 'request_revision';

export interface WorkerReview {
  readonly decision: ReviewDecision;
  readonly reviewer: 'primary_agent';
  readonly summary: string;
  readonly checks: readonly ReviewCheck[];
  readonly at: string;
}

export interface WorkerRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly taskId: string;
  readonly parentTaskId: string | null;
  readonly primaryRunId: string | null;
  readonly workerType: WorkerType;
  readonly status: WorkerStatus;
  readonly assignment: WorkerAssignment;
  readonly resources: readonly ResourceClaim[];
  readonly result: WorkerResult | null;
  readonly review: WorkerReview | null;
  readonly failure: WorkerFailure | null;
  readonly attempts: number;
  /** Earliest time a retried worker may start again. */
  readonly retryNotBefore: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly eventSeq: number;
}

export const WORKER_EVENT_TYPES = [
  'created',
  'status_changed',
  'heartbeat',
  'progress',
  'cancelled',
  'timed_out',
  'failed',
  'retried',
  'reviewed',
  'completed',
] as const;

export type WorkerEventType = (typeof WORKER_EVENT_TYPES)[number];

export interface WorkerEvent {
  readonly workerId: string;
  readonly seq: number;
  readonly type: WorkerEventType;
  readonly actor: 'primary_agent' | 'worker' | 'scheduler' | 'system';
  readonly at: string;
  readonly fromStatus: WorkerStatus | null;
  readonly toStatus: WorkerStatus | null;
  readonly message: string | null;
  readonly detail?: Record<string, unknown>;
}

export interface StoredWorker {
  readonly worker: WorkerRecord;
}

/** One scheduling decision, with the reasons, kept as a record. */
export interface SchedulingDecision {
  readonly id: string;
  readonly ownerRef: string;
  readonly at: string;
  readonly limit: number;
  readonly active: number;
  readonly selected: readonly string[];
  readonly skipped: readonly SkippedWorker[];
}

export interface SkippedWorker {
  readonly workerId: string;
  readonly taskId: string;
  readonly reason:
    | 'not_ready'
    | 'dependency_unmet'
    | 'already_working'
    | 'resource_conflict'
    | 'limit_reached'
    | 'retry_backoff'
    | 'ambiguous_scope';
  readonly detail: string;
}

export const WORKER_LIMITS = {
  maxWorkersPerTask: 1,
  maxConcurrentDefault: 3,
  maxConcurrentCeiling: 8,
  maxAssignmentTextLength: 4000,
  maxDeliverables: 40,
  maxAcceptanceCriteria: 20,
  maxScopePaths: 60,
  maxAllowedTools: 24,
  minDurationMs: 1_000,
  maxDurationMs: 30 * 60_000,
  maxToolCalls: 400,
  /** Heartbeat older than this on a running worker means it is stalled. */
  stallAfterMs: 2 * 60_000,
  maxAttempts: 3,
  /** Doubling backoff, capped. */
  retryBackoffMs: 15_000,
  retryBackoffCeilingMs: 5 * 60_000,
} as const;
