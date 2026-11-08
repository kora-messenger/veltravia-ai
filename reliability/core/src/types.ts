/**
 * @veltravia/reliability-core - Step 51.
 *
 * Coordination primitives for the Step 42-50 pipeline: idempotency records that
 * make a repeated request a replay instead of a second operation, leases that
 * keep two processes from advancing the same execution, a deduplicating event
 * inbox, a sweep that decides what an interrupted execution needs, and a health
 * snapshot built only from observed records.
 *
 * Every store here is a port. This package owns no task lifecycle, no worker
 * lifecycle, no verification and no recovery classification: those stay with the
 * engines that already enforce them.
 */

export interface IdempotencyRecord {
  readonly ownerRef: string;
  /** What operation this key belongs to, for example `POST /api/executions`. */
  readonly scope: string;
  readonly key: string;
  /** Hash of the request this key was first used with. */
  readonly fingerprint: string;
  readonly status: 'in_progress' | 'completed' | 'failed';
  /** Identifies the attempt, so a reclaimed key is visibly a new attempt. */
  readonly operationId: string;
  readonly response: { readonly status: number; readonly body: unknown } | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** After this the key may be reused; a completed result replays until then. */
  readonly expiresAt: string;
}

export interface LeaseRecord {
  readonly ownerRef: string;
  /** What is being held, for example `execution:exe_123`. */
  readonly resource: string;
  readonly holder: string;
  readonly acquiredAt: string;
  readonly renewedAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
  readonly note: string | null;
}

export type InboxStatus = 'pending' | 'processed' | 'failed';

export interface InboxEvent {
  readonly ownerRef: string;
  /** Unique per side effect, so a redelivered event is recognisable. */
  readonly eventKey: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly status: InboxStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  /** When a failed event may be retried. */
  readonly availableAt: string;
}

/** One recorded decision about an interrupted or duplicated unit of work. */
export interface OrchestrationRecovery {
  readonly id: string;
  readonly ownerRef: string;
  readonly executionId: string;
  readonly action: 'resume' | 'recover' | 'await_owner' | 'leave';
  readonly reason: string;
  /** What was observed when the decision was made, as plain lines. */
  readonly evidence: readonly string[];
  readonly holder: string;
  readonly decidedAt: string;
  readonly leaseExpired: boolean;
}

export const RELIABILITY_LIMITS = {
  /** How long a completed idempotency record replays a key. */
  idempotencyRetentionMs: 24 * 60 * 60 * 1000,
  /** An in-flight record older than this is treated as abandoned by its process. */
  idempotencyInFlightMs: 60 * 1000,
  /** Default lease length; long operations renew. */
  leaseTtlMs: 30 * 1000,
  /** Open executions one owner may have at once before intake is refused. */
  maxOpenExecutionsPerOwner: 10,
  /** Executions one sweep pass examines. */
  sweepBatch: 25,
  /** Failed inbox events are retried at most this many times. */
  maxInboxAttempts: 5,
  /** Base delay for an inbox retry; doubles per attempt. */
  inboxRetryBaseMs: 5 * 1000,
} as const;

/** A refusal from the reliability layer, with the status a route should send. */
export class ReliabilityError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ReliabilityError';
    this.code = code;
    this.status = status;
  }
}

export type ReliabilityErrorShape = Pick<ReliabilityError, 'code' | 'message' | 'status'>;
