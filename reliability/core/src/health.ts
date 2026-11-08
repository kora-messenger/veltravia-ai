/**
 * Reliability health.
 *
 * What the machinery looks like right now, from records only. Every number here
 * is a count of something stored; every finding names the observation it rests
 * on. Nothing in this file guesses a cause: "three leases expired" is a fact,
 * "the API is overloaded" would be a diagnosis, and the two are kept apart on
 * purpose.
 */

import type { IdempotencyRecord, InboxEvent, LeaseRecord } from './types.js';

export interface HealthExecutionFact {
  readonly executionId: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly startedAt: string;
}

export interface HealthWorkerFact {
  readonly workerId: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastHeartbeatAt: string | null;
}

export interface HealthTaskFact {
  readonly taskId: string;
  readonly status: string;
}

export interface HealthVerificationFact {
  readonly runId: string;
  readonly status: string;
  readonly executed: boolean;
}

export interface HealthIntegrationFact {
  readonly integrationId: string;
  readonly status: string;
}

export interface HealthRecoveryFact {
  readonly caseId: string;
  readonly status: string;
  readonly openedAt: string;
}

export type HealthLevel = 'ok' | 'attention' | 'critical';

export interface HealthFinding {
  readonly code: string;
  readonly level: HealthLevel;
  readonly summary: string;
  /** The records the finding rests on, in plain words. */
  readonly evidence: readonly string[];
}

export interface ReliabilityHealthInput {
  readonly at: string;
  readonly durable: boolean;
  readonly executions: readonly HealthExecutionFact[];
  readonly workers: readonly HealthWorkerFact[];
  readonly tasks: readonly HealthTaskFact[];
  readonly verifications: readonly HealthVerificationFact[];
  readonly integrations: readonly HealthIntegrationFact[];
  readonly recoveries: readonly HealthRecoveryFact[];
  readonly leases: readonly LeaseRecord[];
  readonly idempotency: readonly IdempotencyRecord[];
  readonly events: readonly InboxEvent[];
  readonly staleHeartbeatMs: number;
  readonly maxOpenExecutions: number;
}

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
  readonly verification: {
    readonly failedRuns: number;
    readonly incompleteRuns: number;
  };
  readonly integration: {
    readonly failed: number;
    readonly pending: number;
  };
  readonly idempotency: {
    readonly inFlight: number;
    readonly failed: number;
    readonly completedLast24h: number;
  };
  readonly events: {
    readonly pending: number;
    readonly failed: number;
  };
  readonly findings: readonly HealthFinding[];
  /** Sources that could not be read; the caller says so rather than guessing. */
  readonly unavailable: readonly string[];
}

const OPEN_EXECUTION_STATUSES = new Set([
  'planning',
  'awaiting_approval',
  'executing',
  'verifying',
  'integrating',
]);

export function buildReliabilityHealth(input: ReliabilityHealthInput): ReliabilityHealth {
  const now = Date.parse(input.at);
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const open = input.executions.filter((entry) => OPEN_EXECUTION_STATUSES.has(entry.status));
  const leasesActive = input.leases.filter((lease) => lease.releasedAt === null);
  const leasesExpired = leasesActive.filter((lease) => lease.expiresAt <= input.at);

  const abandoned = open
    .filter((execution) => {
      const held = leasesActive.find(
        (lease) =>
          lease.resource === `execution:${execution.executionId}` && lease.expiresAt > input.at,
      );
      return held === undefined && now - Date.parse(execution.updatedAt) >= input.staleHeartbeatMs;
    })
    .map((execution) => ({
      executionId: execution.executionId,
      status: execution.status,
      idleSeconds: Math.round((now - Date.parse(execution.updatedAt)) / 1000),
    }));

  const workersQueued = input.workers.filter((worker) =>
    ['queued', 'assigned'].includes(worker.status),
  ).length;
  const workersRunning = input.workers.filter((worker) =>
    ['starting', 'running'].includes(worker.status),
  ).length;
  const awaitingReview = input.workers.filter(
    (worker) => worker.status === 'awaiting_review',
  ).length;
  const blockedWorkers = input.workers.filter((worker) =>
    ['blocked', 'failed', 'timed_out'].includes(worker.status),
  ).length;
  const retrying = input.workers.filter((worker) => worker.attempts > 0);

  const findings: HealthFinding[] = [];
  const add = (
    code: string,
    level: HealthLevel,
    summary: string,
    evidence: readonly string[],
  ): void => {
    findings.push({ code, level, summary, evidence });
  };

  if (!input.durable) {
    add(
      'RELIABILITY_NOT_DURABLE',
      'attention',
      'Idempotency records, leases and event deliveries live in this process only, so a restart forgets them.',
      ['the account is running without a database store'],
    );
  }
  if (leasesExpired.length > 0) {
    add(
      'LEASES_EXPIRED',
      'attention',
      `${leasesExpired.length} lease${leasesExpired.length === 1 ? '' : 's'} expired without being released.`,
      leasesExpired
        .slice(0, 5)
        .map((lease) => `${lease.resource} held by ${lease.holder} until ${lease.expiresAt}`),
    );
  }
  if (abandoned.length > 0) {
    add(
      'EXECUTIONS_ABANDONED',
      'attention',
      `${abandoned.length} open execution${abandoned.length === 1 ? '' : 's'} have not moved and hold no lease.`,
      abandoned
        .slice(0, 5)
        .map((entry) => `${entry.executionId} is ${entry.status}, idle ${entry.idleSeconds}s`),
    );
  }
  if (open.length >= input.maxOpenExecutions) {
    add(
      'EXECUTIONS_AT_LIMIT',
      'attention',
      'The owner is at the open-execution limit, so new intake is refused until some finish.',
      [`${open.length} of ${input.maxOpenExecutions} slots are in use`],
    );
  }
  if (retrying.length > 0) {
    add(
      'WORKERS_RETRIED',
      'ok',
      `${retrying.length} worker${retrying.length === 1 ? '' : 's'} have been attempted more than once.`,
      retrying.slice(0, 5).map((worker) => `${worker.workerId} has ${worker.attempts} attempts`),
    );
  }
  const failedRuns = input.verifications.filter((run) => run.status === 'failed').length;
  if (failedRuns > 0) {
    add(
      'VERIFICATION_FAILED',
      'attention',
      `${failedRuns} verification run${failedRuns === 1 ? '' : 's'} recorded a failure.`,
      input.verifications
        .filter((run) => run.status === 'failed')
        .slice(0, 5)
        .map((run) => run.runId),
    );
  }
  const failedIntegrations = input.integrations.filter((entry) =>
    ['failed', 'rolled_back'].includes(entry.status),
  ).length;
  if (failedIntegrations > 0) {
    add(
      'INTEGRATION_FAILED',
      'attention',
      `${failedIntegrations} integration${failedIntegrations === 1 ? '' : 's'} did not land.`,
      input.integrations
        .filter((entry) => ['failed', 'rolled_back'].includes(entry.status))
        .slice(0, 5)
        .map((entry) => entry.integrationId),
    );
  }
  const escalated = input.recoveries.filter((entry) =>
    ['escalated', 'exhausted'].includes(entry.status),
  ).length;
  if (escalated > 0) {
    add(
      'RECOVERY_ESCALATED',
      'attention',
      `${escalated} recovery case${escalated === 1 ? '' : 's'} ran out of attempts or refused to guess.`,
      input.recoveries
        .filter((entry) => ['escalated', 'exhausted'].includes(entry.status))
        .slice(0, 5)
        .map((entry) => entry.caseId),
    );
  }
  const failedEvents = input.events.filter((event) => event.status === 'failed');
  if (failedEvents.length > 0) {
    add(
      'EVENT_DELIVERY_FAILED',
      'attention',
      `${failedEvents.length} recorded side effect${failedEvents.length === 1 ? '' : 's'} did not complete.`,
      failedEvents.slice(0, 5).map((event) => `${event.topic} after ${event.attempts} attempts`),
    );
  }
  const failedIdempotency = input.idempotency.filter((entry) => entry.status === 'failed').length;
  if (failedIdempotency > 0) {
    add(
      'IDEMPOTENCY_FAILED',
      'ok',
      `${failedIdempotency} keyed request${failedIdempotency === 1 ? '' : 's'} recorded a failure and may be retried with the same key.`,
      [],
    );
  }
  if (findings.length === 0) {
    add(
      'HEALTHY',
      'ok',
      'No expired lease, abandoned execution or failed side effect is recorded.',
      [
        `${input.executions.length} executions, ${input.workers.length} workers, ${input.tasks.length} tasks read`,
      ],
    );
  }

  return {
    generatedAt: input.at,
    durable: input.durable,
    queue: {
      openExecutions: open.length,
      openExecutionLimit: input.maxOpenExecutions,
      tasksQueued: input.tasks.filter((task) => ['queued', 'planning'].includes(task.status))
        .length,
      workersQueued,
      workersRunning,
      awaitingReview,
      blockedWorkers,
    },
    leases: {
      active: leasesActive.length - leasesExpired.length,
      expired: leasesExpired.length,
      holders: [...new Set(leasesActive.map((lease) => lease.holder))],
    },
    abandoned,
    retries: {
      workersWithAttempts: retrying.length,
      totalAttempts: input.workers.reduce((sum, worker) => sum + worker.attempts, 0),
      awaitingRetry: input.workers.filter(
        (worker) => worker.status === 'queued' && worker.attempts > 0,
      ).length,
    },
    recovery: {
      open: input.recoveries.filter((entry) =>
        ['open', 'awaiting_verification', 'repairing'].includes(entry.status),
      ).length,
      escalated,
      last24h: input.recoveries.filter((entry) => entry.openedAt >= dayAgo).length,
    },
    verification: {
      failedRuns,
      incompleteRuns: input.verifications.filter((run) => !run.executed).length,
    },
    integration: {
      failed: failedIntegrations,
      pending: input.integrations.filter((entry) => ['pending', 'running'].includes(entry.status))
        .length,
    },
    idempotency: {
      inFlight: input.idempotency.filter((entry) => entry.status === 'in_progress').length,
      failed: failedIdempotency,
      completedLast24h: input.idempotency.filter(
        (entry) => entry.status === 'completed' && entry.updatedAt >= dayAgo,
      ).length,
    },
    events: {
      pending: input.events.filter((event) => event.status === 'pending').length,
      failed: failedEvents.length,
    },
    findings,
    unavailable: [],
  };
}
