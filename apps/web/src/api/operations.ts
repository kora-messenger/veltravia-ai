import { apiRequest } from './client';

/**
 * Typed client for the Superagent operations surface (Step 47).
 *
 * Every call here goes to a route that already existed before this step, except
 * `changeSetDiff`, the read-only route added so a reviewer can see both sides of
 * a proposal. Nothing here starts work, reviews work or integrates changes on
 * its own: the page calls these only from an explicit control.
 */

// ---------------------------------------------------------------------------
// Workers (Steps 42-44)
// ---------------------------------------------------------------------------

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

export const ACTIVE_WORKER_STATUSES: readonly WorkerStatus[] = [
  'queued',
  'assigned',
  'starting',
  'running',
  'blocked',
  'partially_completed',
  'awaiting_review',
];

export type WorkerType =
  'research' | 'implementation' | 'verification' | 'documentation' | 'review' | 'integration';

export interface WorkerDeliverable {
  readonly name: string;
  readonly kind: string;
  readonly path: string | null;
  readonly summary: string;
  readonly hash?: string | null;
}

export interface WorkerEvidenceView {
  readonly kind: string;
  readonly ref: string;
  readonly summary: string;
  readonly passed?: boolean | null;
}

/** Provider, model and spend for one worker. Never a credential. */
export interface WorkerUsageView {
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** True only when a real provider answered over the network. */
  readonly live: boolean;
}

export interface WorkerResultView {
  readonly summary: string;
  readonly deliverables: readonly WorkerDeliverable[];
  readonly evidence: readonly WorkerEvidenceView[];
  readonly notes: string | null;
  readonly finishedAt: string;
  readonly simulated: boolean;
  readonly usage?: WorkerUsageView | null;
}

export interface ReviewCheckView {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface WorkerReviewView {
  readonly decision: 'accept' | 'reject' | 'request_revision';
  readonly reviewer: 'primary_agent';
  readonly summary: string;
  readonly checks: readonly ReviewCheckView[];
  readonly at: string;
}

export interface WorkerFailureView {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly at: string;
}

export interface WorkerLimitsView {
  readonly maxDurationMs: number;
  readonly maxToolCalls: number;
  readonly maxDeliverables: number;
}

export interface WorkerPermissionsView {
  readonly readProject: boolean;
  readonly writeProject: boolean;
  readonly runTools: boolean;
  readonly network: boolean;
}

export interface WorkerAssignmentView {
  readonly objective: string;
  readonly scope: readonly string[];
  readonly exclusions: readonly string[];
  readonly deliverables: readonly WorkerDeliverable[];
  readonly acceptanceCriteria: readonly string[];
  readonly allowedTools: readonly string[];
  readonly permissions: WorkerPermissionsView;
  readonly verification?: { readonly operations: readonly string[] } | null;
  readonly limits: WorkerLimitsView;
  readonly dependencies: readonly string[];
  readonly checkpoints: readonly string[];
  readonly cancellationConditions: readonly string[];
  readonly reporting: readonly string[];
}

export interface WorkerView {
  readonly id: string;
  readonly taskId: string;
  readonly parentTaskId: string | null;
  readonly workerType: WorkerType;
  readonly status: WorkerStatus;
  readonly assignment: WorkerAssignmentView;
  readonly resources: readonly { readonly kind: string; readonly path: string }[];
  readonly result: WorkerResultView | null;
  readonly review: WorkerReviewView | null;
  readonly failure: WorkerFailureView | null;
  readonly attempts: number;
  readonly retryNotBefore: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly eventSeq: number;
}

export interface WorkerEventView {
  readonly workerId: string;
  readonly seq: number;
  readonly type: string;
  readonly actor: 'primary_agent' | 'worker' | 'scheduler' | 'system';
  readonly at: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
  readonly message: string | null;
  readonly detail?: Record<string, unknown>;
}

export interface WorkerStorageView {
  readonly store: string;
  readonly durable: boolean;
}

export interface WorkerList {
  readonly workers: readonly WorkerView[];
  readonly storage: WorkerStorageView;
}

export async function listWorkers(
  query: { activeOnly?: boolean; taskId?: string; limit?: number } = {},
): Promise<WorkerList> {
  const params = new URLSearchParams();
  if (query.activeOnly === true) params.set('active', 'true');
  if (query.taskId !== undefined) params.set('taskId', query.taskId);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const suffix = params.toString();
  const body = await apiRequest<WorkerList>(`/api/workers${suffix === '' ? '' : `?${suffix}`}`);
  return { workers: body.workers, storage: body.storage };
}

export async function getWorker(workerId: string): Promise<WorkerView> {
  const body = await apiRequest<{ worker: WorkerView }>(
    `/api/workers/${encodeURIComponent(workerId)}`,
  );
  return body.worker;
}

/** Server-recorded events, oldest first. `after` is a sequence number, not a time. */
export async function listWorkerEvents(
  workerId: string,
  after = 0,
  limit = 100,
): Promise<readonly WorkerEventView[]> {
  const body = await apiRequest<{ events: readonly WorkerEventView[] }>(
    `/api/workers/${encodeURIComponent(workerId)}/events?after=${after}&limit=${limit}`,
  );
  return body.events;
}

export async function cancelWorker(workerId: string, reason: string): Promise<WorkerView> {
  const body = await apiRequest<{ worker: WorkerView }>(
    `/api/workers/${encodeURIComponent(workerId)}/cancel`,
    { method: 'POST', body: { reason } },
  );
  return body.worker;
}

export async function requeueWorker(workerId: string, reason: string): Promise<WorkerView> {
  const body = await apiRequest<{ worker: WorkerView }>(
    `/api/workers/${encodeURIComponent(workerId)}/requeue`,
    { method: 'POST', body: { reason } },
  );
  return body.worker;
}

export interface ReviewRequest {
  readonly decision: 'accept' | 'reject' | 'request_revision';
  readonly summary: string;
  readonly criteriaResults?: readonly (boolean | null)[];
  readonly changedPaths?: readonly string[];
}

export interface ReviewOutcome {
  readonly worker: WorkerView;
  readonly checks: readonly ReviewCheckView[];
}

export async function reviewWorker(workerId: string, input: ReviewRequest): Promise<ReviewOutcome> {
  const body = await apiRequest<ReviewOutcome>(
    `/api/workers/${encodeURIComponent(workerId)}/review`,
    { method: 'POST', body: input },
  );
  return { worker: body.worker, checks: body.checks ?? [] };
}

// ---------------------------------------------------------------------------
// Tasks (Step 42)
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'queued'
  | 'planning'
  | 'assigned'
  | 'running'
  | 'blocked'
  | 'partially_completed'
  | 'awaiting_review'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskView {
  readonly id: string;
  readonly projectId: string | null;
  readonly parentTaskId: string | null;
  readonly title: string;
  readonly objective: string;
  readonly status: TaskStatus;
  readonly createdBy: 'primary_agent' | 'owner';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export async function listTasks(limit = 200): Promise<readonly TaskView[]> {
  const body = await apiRequest<{ tasks: readonly TaskView[] }>(`/api/tasks?limit=${limit}`);
  return body.tasks;
}

export interface TaskSuperagentProgress {
  readonly taskId: string;
  readonly taskStatus: TaskStatus;
  readonly active: readonly {
    readonly workerId: string;
    readonly workerType: string;
    readonly status: string;
    readonly objective: string;
    readonly claims: readonly string[];
    readonly startedAt: string | null;
  }[];
  readonly deliverables: readonly {
    readonly workerId: string;
    readonly name: string;
    readonly path: string | null;
  }[];
  readonly blocked: readonly { readonly workerId: string; readonly reason: string }[];
  readonly failedAttempts?: readonly { readonly workerId: string; readonly reason: string }[];
}

export async function taskSuperagents(taskId: string): Promise<TaskSuperagentProgress> {
  return apiRequest<TaskSuperagentProgress>(`/api/tasks/${encodeURIComponent(taskId)}/superagents`);
}

// ---------------------------------------------------------------------------
// Change sets and integration (Step 46)
// ---------------------------------------------------------------------------

export type ChangeSetStatus =
  | 'open'
  | 'validating'
  | 'approved'
  | 'integrating'
  | 'integrated'
  | 'rejected'
  | 'conflicted'
  | 'stale';

export interface ChangeFileView {
  readonly path: string;
  readonly op: 'create' | 'update' | 'delete';
  readonly baseHash: string | null;
  readonly proposedHash: string | null;
  readonly size: number;
  readonly artifactRef: string | null;
}

export interface ChangeSetView {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly taskId: string | null;
  readonly workerId: string | null;
  readonly baseRevision: number;
  readonly title: string;
  readonly files: readonly ChangeFileView[];
  readonly deliverables: readonly string[];
  readonly authorization: {
    readonly allowedPaths: readonly string[];
    readonly excludedPaths: readonly string[];
    readonly allowedTools: readonly string[];
  };
  readonly verification: {
    readonly runIds: readonly string[];
    readonly status: 'none' | 'passed' | 'failed' | 'unknown';
  };
  readonly status: ChangeSetStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly integrationId: string | null;
  readonly scopeComplete: boolean;
}

export interface ChangeProblemView {
  readonly code: string;
  readonly path: string | null;
  readonly message: string;
}

export interface ChangeValidationView {
  readonly ok: boolean;
  readonly problems: readonly ChangeProblemView[];
  readonly stale: readonly { readonly path: string; readonly reason: string }[];
}

export interface ChangeConflictView {
  readonly kind: string;
  readonly paths: readonly string[];
  readonly changeSetIds: readonly string[];
  readonly convergent: boolean;
  readonly message: string;
  readonly suggestion: string;
}

export interface ChangeSetAnalysis {
  readonly currentRevision: number;
  readonly reports: readonly {
    readonly changeSetId: string;
    readonly conflicts: readonly ChangeConflictView[];
    readonly independentPaths: readonly string[];
    readonly blocked: boolean;
  }[];
  readonly conflicts: readonly ChangeConflictView[];
  readonly blocked: boolean;
}

export interface ChangeSetDiffFile {
  readonly path: string;
  readonly op: 'create' | 'update' | 'delete';
  readonly baseHash: string | null;
  readonly proposedHash: string | null;
  readonly size: number;
  readonly base: string | null;
  readonly proposed: string | null;
  readonly baseStale: boolean;
  readonly contentAvailable: boolean;
}

export interface ChangeSetDiff {
  readonly changeSetId: string;
  readonly title: string;
  readonly status: ChangeSetStatus;
  readonly baseRevision: number;
  readonly files: readonly ChangeSetDiffFile[];
  readonly omittedFiles: number;
  readonly maxChars: number;
}

export interface ChangeSetDetail {
  readonly changeSet: ChangeSetView;
  readonly validation: ChangeValidationView;
  readonly currentRevision: number;
}

export async function listChangeSets(
  query: { projectId?: string; status?: readonly ChangeSetStatus[]; limit?: number } = {},
): Promise<readonly ChangeSetView[]> {
  const params = new URLSearchParams();
  if (query.projectId !== undefined) params.set('projectId', query.projectId);
  if (query.status !== undefined && query.status.length > 0) {
    params.set('status', query.status.join(','));
  }
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const suffix = params.toString();
  const body = await apiRequest<{ changeSets: readonly ChangeSetView[] }>(
    `/api/change-sets${suffix === '' ? '' : `?${suffix}`}`,
  );
  return body.changeSets;
}

export async function getChangeSet(changeSetId: string): Promise<ChangeSetDetail> {
  return apiRequest<ChangeSetDetail>(`/api/change-sets/${encodeURIComponent(changeSetId)}`);
}

/** Both sides of every file, bounded by the server. */
export async function changeSetDiff(changeSetId: string): Promise<ChangeSetDiff> {
  const body = await apiRequest<{ diff: ChangeSetDiff }>(
    `/api/change-sets/${encodeURIComponent(changeSetId)}/diff`,
  );
  return body.diff;
}

export async function analyzeChangeSets(
  projectId: string,
  changeSetIds: readonly string[],
): Promise<ChangeSetAnalysis> {
  return apiRequest<ChangeSetAnalysis>('/api/change-sets/analyze', {
    method: 'POST',
    body: { projectId, changeSetIds },
  });
}

export interface IntegrationApprovalView {
  readonly id: string;
  readonly projectId: string;
  readonly changeSetIds: readonly string[];
  readonly decision: 'approve' | 'reject';
  readonly actor: string;
  readonly rationale: string;
  readonly conflictsSeen: readonly string[];
  readonly verificationRequired: boolean;
  readonly createdAt: string;
}

export async function recordApproval(input: {
  projectId: string;
  changeSetIds: readonly string[];
  decision: 'approve' | 'reject';
  rationale: string;
}): Promise<IntegrationApprovalView> {
  const body = await apiRequest<{ approval: IntegrationApprovalView }>(
    '/api/integration/approvals',
    { method: 'POST', body: input },
  );
  return body.approval;
}

export interface IntegrationAppliedFile {
  readonly path: string;
  readonly op: string;
  readonly hash: string | null;
}

export interface IntegrationRecordView {
  readonly id: string;
  readonly projectId: string;
  readonly changeSetIds: readonly string[];
  readonly approvalId: string;
  readonly status: string;
  readonly revisionBefore: number;
  readonly revisionAfter: number | null;
  readonly applied: readonly IntegrationAppliedFile[];
  readonly verification: { readonly status: string; readonly runIds: readonly string[] };
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly rolledBackAt?: string | null;
}

export async function runIntegration(input: {
  projectId: string;
  changeSetIds: readonly string[];
  approvalId: string;
}): Promise<IntegrationRecordView> {
  const body = await apiRequest<{ record: IntegrationRecordView }>('/api/integration/run', {
    method: 'POST',
    body: input,
  });
  return body.record;
}

export async function listIntegrations(
  projectId?: string,
): Promise<readonly IntegrationRecordView[]> {
  const suffix = projectId === undefined ? '' : `?projectId=${encodeURIComponent(projectId)}`;
  const body = await apiRequest<{ records: readonly IntegrationRecordView[] }>(
    `/api/integration/records${suffix}`,
  );
  return body.records;
}

export async function rollbackIntegration(
  integrationId: string,
  reason: string,
): Promise<IntegrationRecordView> {
  const body = await apiRequest<{ record: IntegrationRecordView }>(
    `/api/integration/records/${encodeURIComponent(integrationId)}/rollback`,
    { method: 'POST', body: { reason } },
  );
  return body.record;
}

// ---------------------------------------------------------------------------
// Verification (Step 45)
// ---------------------------------------------------------------------------

export interface VerificationCounts {
  readonly discovered: number | null;
  readonly passed: number | null;
  readonly failed: number | null;
  readonly skipped: number | null;
}

export interface VerificationOperationResult {
  readonly operation: string;
  readonly commandId: string;
  readonly label: string;
  readonly argv: readonly string[];
  readonly status: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly counts: VerificationCounts;
  readonly buildStatus: string;
  readonly errorSummary: string | null;
  readonly outputTail: string;
  readonly truncated: boolean;
  readonly reason: string | null;
  readonly providesOsIsolation: boolean;
}

export interface VerificationRunView {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly workerId: string | null;
  readonly revision: string | null;
  readonly status: string;
  readonly requestedOperations: readonly string[];
  readonly blocked: readonly {
    readonly operation: string;
    readonly reason: string;
    readonly detail: string;
  }[];
  readonly results: readonly VerificationOperationResult[];
  readonly evidence: {
    readonly executed: boolean;
    readonly executedCount: number;
    readonly passedCount: number;
    readonly failedCount: number;
    readonly status: string;
    readonly finishedAt: string | null;
  } | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export async function listVerificationRuns(
  query: { projectId?: string; workerId?: string; limit?: number } = {},
): Promise<readonly VerificationRunView[]> {
  const params = new URLSearchParams();
  if (query.projectId !== undefined) params.set('projectId', query.projectId);
  if (query.workerId !== undefined) params.set('workerId', query.workerId);
  params.set('limit', String(query.limit ?? 50));
  const body = await apiRequest<{ runs: readonly VerificationRunView[] }>(
    `/api/verification/runs?${params.toString()}`,
  );
  return body.runs;
}

// ---------------------------------------------------------------------------
// Scheduler (Step 43)
// ---------------------------------------------------------------------------

export interface SchedulingDecisionView {
  readonly id: string;
  readonly at: string;
  readonly limit: number;
  readonly active: number;
  readonly selected: readonly string[];
  readonly skipped: readonly {
    readonly workerId: string;
    readonly taskId: string;
    readonly reason: string;
  }[];
}

export async function listSchedulingDecisions(): Promise<readonly SchedulingDecisionView[]> {
  const body = await apiRequest<{ decisions: readonly SchedulingDecisionView[] }>(
    '/api/scheduler/decisions',
  );
  return body.decisions;
}
