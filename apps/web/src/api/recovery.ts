import { apiRequest } from './client';

/**
 * Typed client for the recovery surface (Step 48 records, Step 49 reads).
 *
 * Every call is a route that already existed or a filter added to one of them.
 * Nothing here decides a diagnosis, grants a repair or marks a case recovered:
 * the page reads the server's records and calls the owner's own controls.
 */

export const RECOVERY_STATUSES = [
  'open',
  'diagnosing',
  'repairing',
  'awaiting_verification',
  'recovered',
  'escalated',
  'blocked',
  'cancelled',
] as const;

export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];

export const FAILURE_CATEGORIES = [
  'missing_deliverables',
  'unverified_completion',
  'verification_failed',
  'worker_timeout',
  'worker_cancelled',
  'worker_blocked',
  'permission_refused',
  'change_conflict',
  'incompatible_output',
  'repeated_attempts',
  'unknown',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export type RecoveryConfidence = 'low' | 'medium' | 'high';

export interface RecoveryEvidenceView {
  readonly kind: string;
  readonly ref: string;
  readonly detail: string;
}

export interface RecoveryFindingView {
  readonly category: FailureCategory;
  readonly classification: string;
  readonly detail: string;
  readonly evidence: readonly RecoveryEvidenceView[];
}

export interface RecoveryDiagnosisView {
  readonly primary: FailureCategory | null;
  readonly classification: string | null;
  readonly findings: readonly RecoveryFindingView[];
  readonly likelyCause: string | null;
  readonly affectedDeliverables: readonly string[];
  readonly recommendedAction: string | null;
  readonly requiredPermissions: readonly string[];
  readonly confidence: RecoveryConfidence;
  /** Why this conclusion, or why none could be reached. */
  readonly reason: string;
  readonly evidence: readonly RecoveryEvidenceView[];
  /** True when the engine declined to diagnose from the evidence it had. */
  readonly insufficient: boolean;
}

export interface RecoveryObservationView {
  readonly projectId: string;
  readonly taskId: string;
  readonly workerId: string | null;
  readonly workerType: string | null;
  readonly workerStatus: string;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly deliverables: {
    readonly declared: readonly string[];
    readonly produced: readonly string[];
    readonly missing: readonly string[];
  };
  readonly verification: { readonly runId: string; readonly status: string } | null;
  readonly changeSet: { readonly id: string; readonly status: string } | null;
  readonly revision: { readonly base: string | null; readonly now: string | null };
  readonly declaration: {
    readonly scope: readonly string[];
    readonly acceptanceCriteria: readonly string[];
    readonly allowedTools: readonly string[];
  };
}

export interface RecoveryLimitsView {
  readonly maxAttempts: number;
  readonly maxTotalDurationMs: number;
  readonly maxReassignments: number;
}

export interface RecoveryEscalationView {
  readonly reason: string;
  readonly message: string;
  readonly attempted: readonly string[];
  readonly remaining: readonly string[];
  readonly at: string;
}

export interface RecoveryVerificationView {
  readonly runId: string;
  readonly status: 'passed' | 'failed' | 'incomplete' | 'blocked' | 'cancelled';
  /** False when no command actually ran, so nothing was proven. */
  readonly executed: boolean;
  readonly executedCount: number;
  readonly failedOperations: readonly string[];
  readonly evidence: readonly RecoveryEvidenceView[];
}

export interface RecoveryCaseView {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly workerId: string | null;
  readonly workerType: string | null;
  readonly status: RecoveryStatus;
  readonly diagnosis: RecoveryDiagnosisView | null;
  readonly observation: RecoveryObservationView;
  readonly limits: RecoveryLimitsView;
  readonly attempts: number;
  readonly reassignments: number;
  readonly stoppedReason: string | null;
  readonly escalation: RecoveryEscalationView | null;
  readonly verification: RecoveryVerificationView | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface RepairAttemptView {
  readonly id: string;
  readonly attempt: number;
  readonly action: string;
  readonly workerId: string | null;
  readonly workerType: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: string;
  readonly summary: string | null;
  readonly verificationRunId: string | null;
  readonly changeSetId: string | null;
  readonly waitedMs: number;
}

export interface RecoveryEventView {
  readonly caseId: string;
  readonly seq: number;
  readonly type: string;
  readonly actor: string;
  readonly at: string;
  readonly message: string | null;
}

export interface RecoveryOverviewView {
  readonly total: number;
  readonly byStatus: Record<string, number>;
  readonly byCategory: Record<string, number>;
  readonly awaitingDiagnosis: number;
  readonly repairing: number;
  readonly awaitingVerification: number;
  readonly recovered: number;
  readonly needsIntervention: number;
  readonly insufficientEvidence: number;
  readonly verificationFailed: number;
  readonly exhausted: number;
  readonly attemptsUsed: number;
  readonly attemptsRemaining: number;
  readonly truncated: boolean;
  readonly generatedAt: string;
}

export interface RecoveryCaseDetailView {
  readonly case: RecoveryCaseView;
  readonly attempts: readonly RepairAttemptView[];
  readonly events: readonly RecoveryEventView[];
}

export interface RecoveryFilters {
  readonly projectId?: string;
  readonly taskId?: string;
  readonly workerId?: string;
  readonly status?: readonly RecoveryStatus[];
  readonly category?: readonly FailureCategory[];
  readonly verification?: 'passed' | 'failed' | 'not_run';
  /** Cases whose diagnosis declined to name a cause. */
  readonly insufficientEvidence?: boolean;
  /** Cases that have used every attempt the plan allows. */
  readonly exhausted?: boolean;
  readonly since?: string;
  readonly until?: string;
  readonly openOnly?: boolean;
  readonly limit?: number;
}

function queryOf(filters: RecoveryFilters): string {
  const params = new URLSearchParams();
  if (filters.projectId !== undefined) params.set('projectId', filters.projectId);
  if (filters.taskId !== undefined) params.set('taskId', filters.taskId);
  if (filters.workerId !== undefined) params.set('workerId', filters.workerId);
  if (filters.status !== undefined && filters.status.length > 0) {
    params.set('status', filters.status.join(','));
  }
  if (filters.category !== undefined && filters.category.length > 0) {
    params.set('category', filters.category.join(','));
  }
  if (filters.verification !== undefined) params.set('verification', filters.verification);
  if (filters.insufficientEvidence === true) params.set('insufficient', 'true');
  if (filters.exhausted === true) params.set('exhausted', 'true');
  if (filters.since !== undefined) params.set('since', filters.since);
  if (filters.until !== undefined) params.set('until', filters.until);
  if (filters.openOnly === true) params.set('openOnly', 'true');
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export async function getRecoveryOverview(
  filters: RecoveryFilters = {},
): Promise<RecoveryOverviewView> {
  const body = await apiRequest<{ overview: RecoveryOverviewView }>(
    `/api/recovery/overview${queryOf(filters)}`,
  );
  return body.overview;
}

export async function listRecoveryCases(
  filters: RecoveryFilters = {},
): Promise<readonly RecoveryCaseView[]> {
  const body = await apiRequest<{ cases: readonly RecoveryCaseView[] }>(
    `/api/recovery/cases${queryOf(filters)}`,
  );
  return body.cases;
}

export async function getRecoveryCase(caseId: string): Promise<RecoveryCaseDetailView> {
  return apiRequest<RecoveryCaseDetailView>(`/api/recovery/cases/${encodeURIComponent(caseId)}`);
}

/**
 * Ask the server to look again at the evidence it already holds. This never
 * opens a case, starts a repair or marks anything recovered.
 */
export async function reanalyseRecoveryCase(caseId: string): Promise<RecoveryCaseView> {
  const body = await apiRequest<{ case: RecoveryCaseView }>(
    `/api/recovery/cases/${encodeURIComponent(caseId)}/analyse`,
    { method: 'POST', body: {} },
  );
  return body.case;
}

export async function cancelRecoveryCase(
  caseId: string,
  message?: string,
): Promise<RecoveryCaseView> {
  const body = await apiRequest<{ case: RecoveryCaseView }>(
    `/api/recovery/cases/${encodeURIComponent(caseId)}/cancel`,
    { method: 'POST', body: message === undefined ? {} : { message } },
  );
  return body.case;
}
