/**
 * Task orchestration vocabulary.
 *
 * Four identifiers are deliberately separate things and are never
 * interchangeable:
 *
 *   chatId     a conversation. A label for where a request came from.
 *   projectId  a project, and through it a workspace. This is the only
 *              identifier that carries a permission boundary.
 *   taskId     one assigned unit of work, owned by exactly one owner.
 *   runId      one execution attempt of a task. A task may have many runs;
 *              a run never owns a task.
 *
 * `IdentityKind` exists so a value can be checked for what it is rather than
 * trusted for what it is passed as. Authorisation is still decided by the
 * server, never by the shape of an id.
 */

export const TASK_STATUSES = [
  'queued',
  'planning',
  'assigned',
  'running',
  'blocked',
  'partially_completed',
  'awaiting_review',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskActor = 'primary_agent' | 'owner' | 'system' | 'worker';

export type ReviewStatus = 'pending' | 'accepted' | 'rejected';

export interface FailureSummary {
  readonly code: string;
  readonly message: string;
  /** True when the primary agent believes another attempt could succeed. */
  readonly retryable: boolean;
}

export interface RetryMetadata {
  /** Attempts started so far, including a failed one. */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastFailure: FailureSummary | null;
  readonly lastRetriedAt: string | null;
}

export interface CheckpointReference {
  readonly kind: 'revision' | 'snapshot' | 'manual';
  readonly id: string;
  readonly note: string | null;
}

export interface TaskResult {
  readonly summary: string;
  /** Output names the assignment asked for that were actually delivered. */
  readonly outputs: readonly string[];
  readonly finishedAt: string;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
  readonly required: boolean;
}

export interface TaskLimits {
  readonly maxDurationMs: number | null;
  readonly maxToolCalls: number | null;
}

export interface TaskPermissions {
  readonly canReadProject: boolean;
  readonly canWriteProject: boolean;
  readonly canRunTools: boolean;
  readonly canUseNetwork: boolean;
}

/**
 * What a worker would be asked to do. It is a contract, not an execution: no
 * field here starts anything, and nothing in this package claims a worker ran.
 */
export interface TaskAssignment {
  readonly worker: 'primary_agent' | 'superagent';
  readonly objective: string;
  readonly scope: {
    readonly projectId: string | null;
    readonly workspaceId: string | null;
    readonly paths: readonly string[];
  };
  readonly expectedOutputs: readonly string[];
  readonly acceptance: readonly AcceptanceCriterion[];
  readonly allowedTools: readonly string[];
  readonly permissions: TaskPermissions;
  readonly limits: TaskLimits;
  readonly dependsOn: readonly string[];
  readonly checkpoint: CheckpointReference | null;
  /** What the worker must hand back for the primary agent to judge the work. */
  readonly reportingRequirements: readonly string[];
}

export interface TaskRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly chatId: string | null;
  readonly parentTaskId: string | null;
  readonly title: string;
  readonly objective: string;
  readonly status: TaskStatus;
  readonly reviewStatus: ReviewStatus | null;
  readonly assignment: TaskAssignment | null;
  readonly result: TaskResult | null;
  readonly failure: FailureSummary | null;
  readonly retry: RetryMetadata;
  readonly checkpoint: CheckpointReference | null;
  readonly createdBy: 'primary_agent' | 'owner';
  readonly version: number;
  readonly eventSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
}

export type TaskEventType =
  | 'created'
  | 'status_changed'
  | 'assignment_set'
  | 'dependency_added'
  | 'dependency_removed'
  | 'progress'
  | 'attempt_started'
  | 'attempt_finished'
  | 'review_recorded'
  | 'retry_scheduled'
  | 'cancelled'
  | 'checkpoint_linked';

export interface TaskEvent {
  readonly taskId: string;
  readonly seq: number;
  readonly type: TaskEventType;
  readonly actor: TaskActor;
  readonly fromStatus: TaskStatus | null;
  readonly toStatus: TaskStatus | null;
  readonly message: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly at: string;
}

export interface TaskAttempt {
  readonly taskId: string;
  readonly attempt: number;
  readonly runId: string | null;
  readonly worker: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly summary: string | null;
  readonly failure: FailureSummary | null;
}

export interface StoredTask {
  readonly task: TaskRecord;
  readonly dependencies: readonly string[];
}

export interface TaskFilter {
  readonly projectId?: string;
  readonly chatId?: string;
  readonly status?: TaskStatus;
  readonly parentTaskId?: string;
  readonly limit?: number;
}

/** Bounded progress, so a monitor cannot be flooded by a chatty worker. */
export interface TaskProgress {
  readonly step: string;
  readonly message: string | null;
  /** 0-100 when the worker can say; null when it honestly cannot. */
  readonly percent: number | null;
}

export const TASK_LIMITS = {
  maxTitleLength: 160,
  maxObjectiveLength: 4_000,
  maxSummaryLength: 2_000,
  maxDependencies: 25,
  maxDepth: 4,
  maxTasksPerOwner: 5_000,
  maxEventsPerRead: 200,
  maxDependencyChain: 50,
  defaultMaxAttempts: 3,
  hardMaxAttempts: 10,
} as const;

/** A task status the owner cannot leave without a new task. */
export function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

/**
 * How an id describes itself. Never used for authorisation: only for refusing
 * an obviously crossed wire (a run id passed where a task id belongs).
 */
export type IdentityKind = 'chat' | 'project' | 'workspace' | 'task' | 'run' | 'unknown';

export function identifyKind(value: string): IdentityKind {
  if (/^task_[A-Za-z0-9_-]{1,64}$/.test(value)) return 'task';
  if (/^run_[A-Za-z0-9_-]{1,64}$/.test(value)) return 'run';
  if (/^prj_[A-Za-z0-9_-]{1,64}$/.test(value)) return 'project';
  if (/^ws_[A-Za-z0-9_-]{1,64}$/.test(value)) return 'workspace';
  if (/^chat_[A-Za-z0-9_-]{1,96}$/.test(value)) return 'chat';
  return 'unknown';
}
