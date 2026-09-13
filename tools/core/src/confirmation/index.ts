import { createHash } from 'node:crypto';

import type { PermissionRiskLevel } from '@veltravia/connector-core';

/**
 * Stable digest of a requested tool input - used to bind an approval to the
 * exact input that was approved. The digest is a one-way hash: it cannot leak
 * the input (which may contain secrets) if ever surfaced.
 */
export function digestToolInput(input: Readonly<Record<string, unknown>>): string {
  const stable = JSON.stringify(input, (_key, value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return value;
  });
  return createHash('sha256').update(stable).digest('hex');
}

/**
 * Generic human-confirmation abstraction.
 *
 * A confirmation is an explicit, human-made decision that a specific
 * invocation of a (typically risky) tool may proceed. The framework NEVER
 * auto-approves: a confirmation moves from `required` to `approved` ONLY
 * through decide() with an explicit decision - the seam a future UI/agent
 * layer uses to ask "Veltravia AI wants permission to perform this action."
 *
 * States: not_required | required | approved | rejected | expired.
 * Confirmations are single-purpose (tied to one invocation), expire after a
 * TTL, and are never reusable after resolution.
 */

export const CONFIRMATION_STATES = [
  'not_required',
  'required',
  'approved',
  'rejected',
  'expired',
] as const;

export type ConfirmationState = (typeof CONFIRMATION_STATES)[number];

export function isConfirmationState(value: unknown): value is ConfirmationState {
  return typeof value === 'string' && (CONFIRMATION_STATES as readonly string[]).includes(value);
}

/** One human-confirmation request for one invocation. */
export interface ToolConfirmationRequest {
  /** Unique confirmation id (UUID v4). */
  readonly id: string;
  /** The invocation this confirmation authorizes. */
  readonly invocationId: string;
  /** The tool being invoked. */
  readonly toolId: string;
  /** The tool's risk level at request time. */
  readonly riskLevel: PermissionRiskLevel;
  /** Current lifecycle state of the confirmation. */
  readonly state: Exclude<ConfirmationState, 'not_required'>;
  /** ISO-8601 creation time. */
  readonly requestedAt: string;
  /** ISO-8601 time after which an undecided confirmation is expired. */
  readonly expiresAt: string;
  /** ISO-8601 time the decision was made, if it was. */
  readonly decidedAt?: string;
  /** SHA-256 digest of the approved input - approvals bind to exact input. */
  readonly inputDigest: string;
  /** ISO-8601 time the approval was consumed by an execution, if it was. */
  readonly consumedAt?: string;
}

export type ConfirmationDecision = 'approved' | 'rejected';

export interface InMemoryConfirmationServiceOptions {
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /** How long a confirmation stays decidable. Default: 5 minutes. */
  readonly ttlMs?: number;
}

/**
 * Deterministic in-memory confirmation service. Persistence arrives with a
 * later step; the interface is what future stores must satisfy.
 */
export class InMemoryConfirmationService {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly requests = new Map<string, ToolConfirmationRequest>();

  constructor(options: InMemoryConfirmationServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  }

  /** Opens a confirmation request for an invocation (state: required). */
  request(
    toolId: string,
    invocationId: string,
    riskLevel: PermissionRiskLevel,
    inputDigest: string,
  ): ToolConfirmationRequest {
    const now = this.now();
    const request: ToolConfirmationRequest = {
      id: randomId(),
      invocationId,
      toolId,
      riskLevel,
      state: 'required',
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      inputDigest,
    };
    this.requests.set(request.id, request);
    return request;
  }

  /** Retrieves a confirmation, applying expiry to still-open requests. */
  get(confirmationId: string): ToolConfirmationRequest {
    const request = this.requests.get(confirmationId);
    if (request === undefined) {
      throw new Error(`Unknown confirmation id "${confirmationId}".`);
    }
    return this.applyExpiry(request);
  }

  /**
   * Records an explicit human decision. Throws if the confirmation is
   * unknown, already decided, or expired. Never invents a decision.
   */
  decide(confirmationId: string, decision: ConfirmationDecision): ToolConfirmationRequest {
    const current = this.get(confirmationId);
    if (current.state === 'expired') {
      throw new Error('Confirmation has expired - a new invocation is required.');
    }
    if (current.state !== 'required') {
      throw new Error(`Confirmation is already ${current.state}.`);
    }
    const decided: ToolConfirmationRequest = {
      ...current,
      state: decision,
      decidedAt: this.now().toISOString(),
    };
    this.requests.set(confirmationId, decided);
    return decided;
  }

  /**
   * Marks an APPROVED confirmation as consumed by one execution.
   * Approvals are single-use: a second consume throws. This is what makes an
   * approval impossible to replay.
   */
  consume(confirmationId: string): ToolConfirmationRequest {
    const current = this.get(confirmationId);
    if (current.state !== 'approved') {
      throw new Error(`Confirmation is ${current.state}, not approved.`);
    }
    if (current.consumedAt !== undefined) {
      throw new Error('Confirmation has already been used by an execution.');
    }
    const consumed: ToolConfirmationRequest = {
      ...current,
      consumedAt: this.now().toISOString(),
    };
    this.requests.set(confirmationId, consumed);
    return consumed;
  }

  /** Number of tracked confirmations (test/inspection aid). */
  get size(): number {
    return this.requests.size;
  }

  private applyExpiry(request: ToolConfirmationRequest): ToolConfirmationRequest {
    if (request.state !== 'required') return request;
    if (this.now().getTime() < Date.parse(request.expiresAt)) return request;
    const expired: ToolConfirmationRequest = { ...request, state: 'expired' };
    this.requests.set(request.id, expired);
    return expired;
  }
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}
