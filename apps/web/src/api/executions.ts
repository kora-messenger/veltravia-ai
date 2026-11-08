import { apiRequest } from './client';

/**
 * Typed client for the execution surface (Step 50).
 *
 * The page reads the coordinator's own view and calls the owner's own controls.
 * Nothing here decides a plan, proves a test run or merges a change: those
 * answers come from the task, verification and change-set records the
 * coordinator reconciles against.
 */

export const EXECUTION_STATUSES = [
  'intake',
  'planning',
  'awaiting_approval',
  'executing',
  'verifying',
  'awaiting_review',
  'integrating',
  'recovering',
  'completed',
  'partially_completed',
  'blocked',
  'failed',
  'cancelled',
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const PROGRESS_STATES = [
  'ready',
  'running',
  'review',
  'done',
  'waiting',
  'blocked',
  'failed',
] as const;

export type ProgressState = (typeof PROGRESS_STATES)[number];

export interface ExecutionSummaryView {
  readonly id: string;
  readonly projectId: string;
  readonly status: ExecutionStatus;
  readonly objective: string;
  readonly taskIds: readonly string[];
  readonly workerIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stoppedReason: string | null;
}

export interface PlannedTaskView {
  readonly key: string;
  readonly title: string;
  readonly workerType: string;
  readonly phase: string;
  readonly dependsOn: readonly string[];
  readonly scope: readonly string[];
  readonly verification: string;
  readonly approval: string | null;
  readonly taskId: string | null;
}

export interface PlanView {
  readonly objective: string;
  readonly tasks: readonly PlannedTaskView[];
  readonly approvals: readonly { readonly reason: string; readonly taskKey: string }[];
  readonly notes: readonly string[];
}

export interface ProgressLineView {
  readonly key: string;
  readonly title: string;
  readonly status: ProgressState;
  readonly workerId: string | null;
  readonly note: string | null;
}

export interface ProgressView {
  readonly outcome: string;
  readonly tasks: readonly ProgressLineView[];
  readonly counts: Readonly<Record<string, number>>;
  readonly evidence: {
    readonly verificationRuns: number;
    readonly changeSets: number;
    readonly recoveryCases: number;
  };
}

export interface ExecutionView {
  readonly execution: ExecutionSummaryView;
  readonly plan: PlanView;
  readonly progress: ProgressView;
}

export interface DeliveryReportView {
  readonly executionId: string;
  readonly objective: string;
  readonly outcome: string;
  readonly completed: readonly string[];
  readonly partial: readonly string[];
  readonly blocked: readonly string[];
  readonly failed: readonly string[];
  readonly notStarted: readonly string[];
  readonly verification: readonly string[];
  readonly limits: readonly string[];
}

export interface ExecutionCapabilities {
  readonly maxConcurrent: { readonly default: number; readonly ceiling: number };
  readonly requiresVerificationFor: readonly string[];
  readonly approvalReasons: readonly string[];
  readonly progress: string;
  readonly simulatedWorkers: boolean;
  readonly autoIntegration: boolean;
}

export async function listExecutions(
  options: {
    projectId?: string;
    openOnly?: boolean;
    limit?: number;
  } = {},
): Promise<readonly ExecutionSummaryView[]> {
  const query = new URLSearchParams();
  if (options.projectId !== undefined) query.set('projectId', options.projectId);
  if (options.openOnly === true) query.set('open', 'true');
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const suffix = query.toString();
  const body = await apiRequest<{ executions: readonly ExecutionSummaryView[] }>(
    `/api/executions${suffix.length > 0 ? `?${suffix}` : ''}`,
  );
  return body.executions;
}

export async function getExecution(
  executionId: string,
): Promise<ExecutionView & { readonly report: DeliveryReportView }> {
  return apiRequest<ExecutionView & { readonly report: DeliveryReportView }>(
    `/api/executions/${encodeURIComponent(executionId)}`,
  );
}

export async function startExecution(input: {
  projectId: string;
  request: string;
  workspaceId?: string;
  maxConcurrent?: number;
}): Promise<ExecutionView> {
  return apiRequest<ExecutionView>('/api/executions', { method: 'POST', body: input });
}

export async function dispatchExecution(executionId: string): Promise<ExecutionView> {
  return apiRequest<ExecutionView>(`/api/executions/${encodeURIComponent(executionId)}/dispatch`, {
    method: 'POST',
  });
}

export async function syncExecution(executionId: string): Promise<ExecutionView> {
  return apiRequest<ExecutionView>(`/api/executions/${encodeURIComponent(executionId)}/sync`, {
    method: 'POST',
  });
}

export async function reviewExecutionTask(
  executionId: string,
  taskId: string,
  decision: 'accept' | 'reject',
  note = '',
): Promise<ExecutionView> {
  return apiRequest<ExecutionView>(
    `/api/executions/${encodeURIComponent(executionId)}/tasks/${encodeURIComponent(taskId)}/review`,
    { method: 'POST', body: { decision, note } },
  );
}

export async function cancelExecution(executionId: string): Promise<ExecutionView> {
  return apiRequest<ExecutionView>(`/api/executions/${encodeURIComponent(executionId)}/cancel`, {
    method: 'POST',
  });
}

export async function getExecutionCapabilities(): Promise<ExecutionCapabilities> {
  const body = await apiRequest<{ capabilities: ExecutionCapabilities }>(
    '/api/executions/capabilities',
  );
  return body.capabilities;
}
