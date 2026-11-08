/**
 * @veltravia/execution-core - Step 50.
 *
 * The Primary Agent's coordination layer: it turns one natural-language request
 * into a plan, a dependency graph of tasks, bounded worker assignments, and an
 * evidence-based delivery report. It owns no task engine, no scheduler, no
 * verification, no change integration and no recovery: every one of those is a
 * port implemented by Steps 42-49. Nothing here duplicates them.
 */

/** What a task in an execution is for. Drives which worker type is chosen. */
export const EXECUTION_TASK_KINDS = [
  'analysis',
  'frontend',
  'backend',
  'database',
  'integration',
  'testing',
  'documentation',
  'security',
  'performance',
  'bugfix',
] as const;

export type ExecutionTaskKind = (typeof EXECUTION_TASK_KINDS)[number];

export const EXECUTION_STATUSES = [
  'planning',
  'awaiting_approval',
  'executing',
  'verifying',
  'integrating',
  'completed',
  'partially_completed',
  'blocked',
  'failed',
  'cancelled',
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** How a planned task is allowed to run relative to its siblings. */
export type ExecutionTaskPhase = 'independent' | 'sequential' | 'specialist' | 'approval';

export interface ExecutionRequest {
  /** The owner's words, kept verbatim as the record's origin. */
  readonly text: string;
  readonly projectId: string;
  readonly workspaceId: string | null;
  /** The owner asked for something that needs a gate before it happens. */
  readonly requiresApproval: boolean;
  /** Why approval is needed, in plain words, when it is. */
  readonly approvalReasons: readonly string[];
  readonly receivedAt: string;
}

export interface ProjectFacts {
  /** Paths the inspector could read, bounded by the caller. */
  readonly files: readonly string[];
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  /** Names only, never values. */
  readonly hasPackageJson: boolean;
  readonly hasTests: boolean;
  readonly hasDocs: boolean;
  readonly revision: string | null;
  /** What the inspector could not determine, said plainly. */
  readonly unknown: readonly string[];
}

export interface PlannedTask {
  /** Stable within the execution; becomes the real task id when created. */
  readonly key: string;
  readonly title: string;
  readonly objective: string;
  readonly kind: ExecutionTaskKind;
  readonly workerType: string;
  readonly phase: ExecutionTaskPhase;
  /** Keys of tasks that must be completed first. */
  readonly dependsOn: readonly string[];
  readonly scope: readonly string[];
  readonly exclusions: readonly string[];
  readonly deliverables: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly allowedTools: readonly string[];
  /** 1-5. Planning guidance only; never billed as progress. */
  readonly complexity: number;
  readonly verification: 'none' | 'typecheck' | 'unit' | 'integration' | 'build';
  /** What the owner must approve before this task may start. */
  readonly approval: string | null;
  /** The real task id once the task engine created it. */
  readonly taskId: string | null;
}

export interface ExecutionPlan {
  readonly version: number;
  readonly objective: string;
  /** One line per thing the Primary Agent inspected. */
  readonly inspection: readonly string[];
  readonly tasks: readonly PlannedTask[];
  readonly risks: readonly string[];
  readonly restrictions: readonly string[];
  readonly verificationRequirements: readonly string[];
  readonly summary: string;
  /** Why this revision exists; required from version 2 onward. */
  readonly revisionReason: string | null;
  readonly createdAt: string;
}

export interface ExecutionApproval {
  readonly id: string;
  /** 'task' for a gated task, 'scope_change' for work the owner did not request. */
  readonly kind: 'task' | 'scope_change';
  readonly taskKey: string | null;
  readonly reason: string;
  readonly state: 'pending' | 'approved' | 'refused';
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly note: string | null;
}

export interface ExecutionRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string;
  readonly workspaceId: string | null;
  readonly status: ExecutionStatus;
  readonly request: ExecutionRequest;
  readonly plan: ExecutionPlan;
  /** Every plan the Primary Agent has issued, oldest first. */
  readonly revisions: readonly ExecutionPlan[];
  readonly approvals: readonly ExecutionApproval[];
  readonly taskIds: readonly string[];
  /** Worker ids dispatched for this execution, in dispatch order. */
  readonly workerIds: readonly string[];
  /** Recovery cases opened for this execution's workers. */
  readonly recoveryCaseIds: readonly string[];
  /** Change sets integrated on this execution's behalf. */
  readonly changeSetIds: readonly string[];
  readonly maxConcurrent: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  /** Why the execution stopped, in plain words, when it did not simply finish. */
  readonly stoppedReason: string | null;
  readonly version: number;
}

// ---------------------------------------------------------------------------
// Evidence the progress and report layers read. Every field is copied from a
// stored record; none of it is a worker's own percentage.
// ---------------------------------------------------------------------------

export interface TaskFacts {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly reviewStatus: string | null;
  readonly dependencies: readonly string[];
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly resultSummary: string | null;
  readonly updatedAt: string | null;
  readonly deliverables: readonly string[];
  readonly workerId: string | null;
}

export interface WorkerFacts {
  readonly workerId: string;
  readonly taskId: string;
  readonly workerType: string;
  readonly status: string;
  readonly simulated: boolean;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly deliverables: readonly string[];
  readonly evidence: readonly { readonly kind: string; readonly ref: string }[];
}

export interface VerificationFacts {
  readonly runId: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly workerId: string | null;
  readonly status: string;
  readonly executed: boolean;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly operations: readonly string[];
  readonly finishedAt: string | null;
}

export interface ChangeSetFacts {
  readonly changeSetId: string;
  readonly taskId: string | null;
  readonly workerId: string | null;
  readonly status: string;
  readonly files: readonly string[];
}

export interface RecoveryFacts {
  readonly caseId: string;
  readonly taskId: string;
  readonly workerId: string | null;
  readonly status: string;
  readonly category: string | null;
  readonly escalationReason: string | null;
}

/** Everything the coordinator is allowed to look at when it reports. */
export interface ExecutionEvidence {
  readonly tasks: readonly TaskFacts[];
  readonly workers: readonly WorkerFacts[];
  readonly verifications: readonly VerificationFacts[];
  readonly changeSets: readonly ChangeSetFacts[];
  readonly recoveries: readonly RecoveryFacts[];
}

export interface TaskProgressLine {
  readonly key: string;
  readonly title: string;
  readonly kind: ExecutionTaskKind;
  readonly status: 'waiting' | 'ready' | 'running' | 'review' | 'done' | 'blocked' | 'failed';
  readonly taskId: string | null;
  readonly workerId: string | null;
  readonly workerType: string;
  readonly dependsOn: readonly string[];
  /** True only when a stored verification run covering this task executed and passed. */
  readonly verified: boolean;
  readonly integrated: boolean;
  readonly recoveryCaseId: string | null;
  /** Why it is blocked, in plain words, or null. */
  readonly note: string | null;
}

export interface ExecutionProgress {
  readonly status: ExecutionStatus;
  readonly tasks: readonly TaskProgressLine[];
  readonly counts: {
    readonly total: number;
    readonly waiting: number;
    readonly ready: number;
    readonly running: number;
    /** Finished work that has not been reviewed or integrated yet. */
    readonly review: number;
    readonly done: number;
    readonly blocked: number;
    readonly failed: number;
  };
  /** Waits on the owner, not on the system. */
  readonly awaitingApproval: readonly string[];
  /** Proof still missing before the execution can be called complete. */
  readonly outstanding: readonly string[];
  readonly updatedAt: string;
}

export interface DeliveryReport {
  readonly executionId: string;
  readonly objective: string;
  readonly outcome: 'completed' | 'partially_completed' | 'blocked' | 'failed' | 'cancelled';
  readonly completed: readonly string[];
  readonly partial: readonly string[];
  readonly blocked: readonly string[];
  readonly failed: readonly string[];
  readonly notStarted: readonly string[];
  readonly awaitingApproval: readonly string[];
  readonly filesChanged: readonly string[];
  readonly workers: readonly {
    readonly workerId: string;
    readonly taskId: string;
    readonly workerType: string;
    readonly status: string;
    readonly simulated: boolean;
  }[];
  readonly verification: readonly {
    readonly runId: string;
    readonly status: string;
    readonly executed: boolean;
    readonly passedCount: number;
    readonly failedCount: number;
  }[];
  readonly integration: readonly {
    readonly changeSetId: string;
    readonly taskId: string | null;
    readonly status: string;
    readonly files: readonly string[];
  }[];
  readonly recovery: readonly {
    readonly caseId: string;
    readonly taskId: string;
    readonly status: string;
    readonly category: string | null;
  }[];
  /** What is still not true, stated plainly. */
  readonly limitations: readonly string[];
  /** What the owner has to do next. */
  readonly requiredActions: readonly string[];
  readonly generatedAt: string;
}
