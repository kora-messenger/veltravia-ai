import { apiRequest } from './client';

/**
 * Typed client for the reliability surface (Step 51).
 *
 * These reads describe the machinery around the work: which requests were
 * keyed, which side effects are outstanding, what a sweep decided and whether
 * the coordination is durable at all. None of it can complete a task or approve
 * a change.
 *
 * `Idempotency-Key` is sent by the mutating helpers here and nowhere else: the
 * sweep is the one POST, and a retried sweep must return the first sweep's
 * decision rather than sweeping twice.
 */

export type HealthLevel = 'ok' | 'attention' | 'critical';

export interface ReliabilityHealth {
  readonly generatedAt: string;
  readonly durable: boolean;
  readonly queue: {
    readonly openExecutions: number;
    readonly openExecutionLimit: number;
    readonly tasksQueued: number;
    readonly workersQueued: number;
    readonly workersRunning: number;
    readonly awaitingReview: number;
    readonly blockedWorkers: number;
  };
  readonly leases: {
    readonly active: number;
    readonly expired: number;
    readonly holders: readonly string[];
  };
  readonly abandoned: readonly {
    readonly executionId: string;
    readonly status: string;
    readonly idleSeconds: number;
  }[];
  readonly retries: {
    readonly workersWithAttempts: number;
    readonly totalAttempts: number;
    readonly awaitingRetry: number;
  };
  readonly recovery: {
    readonly open: number;
    readonly escalated: number;
    readonly last24h: number;
  };
  readonly verification: { readonly failedRuns: number; readonly incompleteRuns: number };
  readonly integration: { readonly failed: number; readonly pending: number };
  readonly idempotency: {
    readonly inFlight: number;
    readonly failed: number;
    readonly completedLast24h: number;
  };
  readonly events: { readonly pending: number; readonly failed: number };
  readonly findings: readonly {
    readonly code: string;
    readonly level: HealthLevel;
    readonly summary: string;
    readonly evidence: readonly string[];
  }[];
  /** Sources that could not be read. The page says so instead of showing zeros. */
  readonly unavailable: readonly string[];
}

export interface RecoveryDecision {
  readonly executionId: string;
  readonly action: 'resume' | 'recover' | 'await_owner' | 'leave';
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly ownerAction: string | null;
}

export interface SweepResult {
  readonly examined: number;
  readonly skipped: number;
  readonly recoveredWorkers: number;
  readonly decisions: readonly RecoveryDecision[];
}

export interface KeyRecordView {
  readonly scope: string;
  readonly keyHint: string;
  readonly status: 'in_progress' | 'completed' | 'failed';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface SideEffectView {
  readonly eventKey: string;
  readonly topic: string;
  readonly status: 'pending' | 'processed' | 'failed';
  readonly attempts: number;
  readonly lastError: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  readonly availableAt: string | null;
}

export interface ReliabilityCapabilities {
  readonly durable: boolean;
  readonly holder: string;
  readonly idempotency: { readonly header: string; readonly retentionHours: number };
  readonly leases: { readonly ttlSeconds: number };
  readonly backpressure: { readonly maxOpenExecutionsPerOwner: number };
  readonly excluded: readonly string[];
}

export async function getReliabilityHealth(): Promise<ReliabilityHealth> {
  const body = await apiRequest<{ health: ReliabilityHealth }>('/api/reliability/health');
  return body.health;
}

export async function getReliabilityCapabilities(): Promise<ReliabilityCapabilities> {
  const body = await apiRequest<{ capabilities: ReliabilityCapabilities }>(
    '/api/reliability/capabilities',
  );
  return body.capabilities;
}

export async function getRecoveryDecisions(executionId?: string): Promise<RecoveryDecision[]> {
  const query = executionId === undefined ? '' : `?executionId=${encodeURIComponent(executionId)}`;
  const body = await apiRequest<{ recoveries: RecoveryDecision[] }>(
    `/api/reliability/recoveries${query}`,
  );
  return body.recoveries;
}

export async function listKeyRecords(
  filter: {
    readonly scope?: string;
    readonly status?: readonly KeyRecordView['status'][];
  } = {},
): Promise<KeyRecordView[]> {
  const params = new URLSearchParams();
  if (filter.scope !== undefined && filter.scope !== '') params.set('scope', filter.scope);
  if (filter.status !== undefined && filter.status.length > 0) {
    params.set('status', filter.status.join(','));
  }
  const query = params.toString();
  const body = await apiRequest<{ keys: KeyRecordView[] }>(
    `/api/reliability/keys${query === '' ? '' : `?${query}`}`,
  );
  return body.keys;
}

export async function listSideEffects(
  filter: {
    readonly topic?: string;
    readonly status?: readonly SideEffectView['status'][];
  } = {},
): Promise<SideEffectView[]> {
  const params = new URLSearchParams();
  if (filter.topic !== undefined && filter.topic !== '') params.set('topic', filter.topic);
  if (filter.status !== undefined && filter.status.length > 0) {
    params.set('status', filter.status.join(','));
  }
  const query = params.toString();
  const body = await apiRequest<{ events: SideEffectView[] }>(
    `/api/reliability/events${query === '' ? '' : `?${query}`}`,
  );
  return body.events;
}

/**
 * One sweep. The key is derived from the minute, so a double click or a retried
 * request within the same minute returns the decision that already exists
 * instead of examining the queue again.
 */
export async function runSweep(): Promise<SweepResult> {
  const minute = Math.floor(Date.now() / 60_000);
  const body = await apiRequest<{ sweep: SweepResult }>('/api/reliability/sweep', {
    method: 'POST',
    headers: { 'Idempotency-Key': `sweep_${minute}` },
    body: {},
  });
  return body.sweep;
}
