import { apiRequest } from './client';

/**
 * Application-testing client (Step 39).
 *
 * The vocabulary mirrors the server's, and every response is checked before the
 * page sees it, so a screen cannot show a field the server did not send.
 *
 * About identity: this client sends NO owner header on purpose. The projects
 * the web app creates belong to the server's development owner, and the testing
 * routes apply the same rule to a request with no header, so the caller finds
 * its own projects. Sending the per-browser id here would make every project
 * look like someone else's. When real authentication replaces the development
 * owner, it replaces it for both.
 */

export type AppTestStatus = 'PASSED' | 'FAILED' | 'PARTIALLY_PASSED' | 'CANCELLED' | 'BLOCKED';
export type AppTestOutcome = 'passed' | 'failed' | 'skipped';
export type BugSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type BugCertainty = 'confirmed' | 'suspected';
export type BugCategory =
  | 'functional'
  | 'ui'
  | 'api'
  | 'database'
  | 'authentication'
  | 'performance'
  | 'security'
  | 'configuration';

export type TestRunState =
  | 'created'
  | 'planning'
  | 'awaiting_approval'
  | 'approved'
  | 'running'
  | 'analyzing'
  | 'awaiting_repair_approval'
  | 'repairing'
  | 'retesting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PendingApproval {
  readonly kind: string;
  readonly summary?: string;
  readonly [key: string]: unknown;
}

export interface AppInspection {
  readonly fileCount: number;
  readonly truncated: boolean;
  readonly frontend: string;
  readonly backend: string;
  readonly testRunner: string;
  readonly databases: readonly string[];
  readonly entryPoints: readonly string[];
  readonly apiRoutes: readonly { method: string; path: string; file: string; guarded: boolean }[];
  readonly pageRoutes: readonly { method: string; path: string; file: string }[];
  readonly existingTests: readonly { path: string; runner: string }[];
  readonly dependencies: readonly string[];
  readonly hasAuth: boolean;
  readonly hasForms: boolean;
  readonly notes: readonly string[];
}

export interface ProposedTest {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly target: string;
  readonly path: string;
  readonly runner: string;
}

export interface StartedRun {
  readonly runId: string;
  readonly state: TestRunState;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly inspection: AppInspection;
  readonly proposedTests: readonly ProposedTest[];
  readonly skippedKinds: readonly { kind: string; reason: string }[];
  readonly notes: readonly string[];
}

export interface RunStatus {
  readonly runId: string;
  readonly state: TestRunState;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly pendingApproval: PendingApproval | null;
  readonly repairAttempts: number;
  readonly commandsExecuted: number;
  readonly failure: { code: string; message: string } | null;
  readonly notes: readonly string[];
}

export interface AppTestResult {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly outcome: AppTestOutcome;
  readonly skipReason: string | null;
  readonly error: string | null;
  readonly durationMs: number | null;
}

export interface Bug {
  readonly id: string;
  readonly category: BugCategory;
  readonly severity: BugSeverity;
  readonly certainty: BugCertainty;
  readonly title: string;
  readonly summary: string;
  readonly affectedFiles: readonly string[];
  readonly evidence: string;
  readonly recommendation: string;
  readonly source: string;
}

export interface AppTestReport {
  readonly projectId: string;
  readonly runId: string;
  readonly environment: {
    readonly runtimeId: string;
    readonly osIsolation: boolean;
    readonly executedRealCode: boolean;
    readonly networkPolicy: string;
  };
  readonly status: AppTestStatus;
  readonly statusReason: string;
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly tests: readonly AppTestResult[];
  readonly bugs: readonly Bug[];
  readonly findings: readonly { id: string; rule: string; severity: BugSeverity }[];
  readonly regression: {
    readonly ran: boolean;
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly regressed: readonly string[];
    readonly fixed: readonly string[];
    readonly note: string;
  };
  readonly fullyTested: boolean;
  readonly generatedAt: string;
}

export interface RepairPlanView {
  readonly runId: string;
  readonly state: TestRunState;
  readonly awaitingApproval: boolean;
  readonly diagnosis: unknown;
  readonly repairPlan: unknown;
  readonly approvalRoute: string;
}

const STATUSES: readonly string[] = [
  'PASSED',
  'FAILED',
  'PARTIALLY_PASSED',
  'CANCELLED',
  'BLOCKED',
];
const STATES: readonly string[] = [
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bad(what: string): never {
  throw new Error(`The testing service sent ${what} in an unexpected shape.`);
}

export function parseStarted(payload: unknown): StartedRun {
  if (
    !isRecord(payload) ||
    typeof payload['runId'] !== 'string' ||
    typeof payload['state'] !== 'string' ||
    !STATES.includes(payload['state']) ||
    !isRecord(payload['inspection']) ||
    !Array.isArray(payload['proposedTests'])
  ) {
    return bad('the new run');
  }
  return payload as unknown as StartedRun;
}

export function parseStatus(payload: unknown): RunStatus {
  if (
    !isRecord(payload) ||
    typeof payload['runId'] !== 'string' ||
    typeof payload['state'] !== 'string' ||
    !STATES.includes(payload['state'])
  ) {
    return bad('the run status');
  }
  return payload as unknown as RunStatus;
}

export function parseReport(payload: unknown): AppTestReport {
  const report = isRecord(payload) ? payload['report'] : undefined;
  if (
    !isRecord(report) ||
    typeof report['status'] !== 'string' ||
    !STATUSES.includes(report['status']) ||
    typeof report['statusReason'] !== 'string' ||
    !Array.isArray(report['tests']) ||
    !Array.isArray(report['bugs']) ||
    !isRecord(report['environment']) ||
    !isRecord(report['regression'])
  ) {
    return bad('the report');
  }
  return report as unknown as AppTestReport;
}

export async function startRun(
  input: { projectId: string; workspaceId: string },
  options: { fetchImpl?: typeof fetch } = {},
): Promise<StartedRun> {
  const payload = await apiRequest<unknown>('/api/app-testing/runs', {
    method: 'POST',
    body: input,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return parseStarted(payload);
}

export async function fetchStatus(
  runId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<RunStatus> {
  const payload = await apiRequest<unknown>(`/api/app-testing/runs/${encodeURIComponent(runId)}`, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return parseStatus(payload);
}

export async function fetchReport(
  runId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<AppTestReport> {
  const payload = await apiRequest<unknown>(
    `/api/app-testing/runs/${encodeURIComponent(runId)}/report`,
    { ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) },
  );
  return parseReport(payload);
}

export async function fetchRepairPlan(
  runId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<RepairPlanView> {
  const payload = await apiRequest<unknown>(
    `/api/app-testing/runs/${encodeURIComponent(runId)}/repair-plan`,
    { ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) },
  );
  if (!isRecord(payload) || typeof payload['approvalRoute'] !== 'string') {
    return bad('the repair plan');
  }
  return payload as unknown as RepairPlanView;
}

export async function cancelRun(
  runId: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ runId: string; state: TestRunState }> {
  const payload = await apiRequest<unknown>(
    `/api/app-testing/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: 'POST',
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    },
  );
  if (!isRecord(payload) || typeof payload['state'] !== 'string') return bad('the cancellation');
  return payload as unknown as { runId: string; state: TestRunState };
}

/**
 * A person's decision on a pending approval: the plan, a sandbox command or a
 * repair. This is the existing approval route; the run never decides for itself.
 */
export async function decide(
  runId: string,
  decision: 'approve' | 'reject',
  options: { fetchImpl?: typeof fetch } = {},
): Promise<RunStatus> {
  const payload = await apiRequest<unknown>(
    `/api/testing/runs/${encodeURIComponent(runId)}/approval`,
    {
      method: 'POST',
      body: { decision },
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    },
  );
  return parseStatus(payload);
}
