/**
 * Event inbox.
 *
 * The engines already append their own event records (task events, worker
 * events, recovery events). This is not a second event log: it is the inbox for
 * side effects that must happen once even if the cause is delivered twice - a
 * duplicate or delayed event, a retried sweep, a redelivered webhook.
 *
 * A side effect is recorded under a key derived from its cause (for example
 * `recovery_case:<workerId>`). The first delivery takes the key and runs the
 * work; later deliveries of the same key find the row and do nothing. A failed
 * attempt is recorded with its error and a retry time, so a restart can carry on
 * instead of losing the work or repeating it blindly.
 */

import { RELIABILITY_LIMITS, type InboxEvent } from './types.js';

export interface EventInboxStore {
  /** Insert-only: false means this event key was already delivered. */
  receive(event: InboxEvent): Promise<boolean>;
  markProcessed(ownerRef: string, eventKey: string, at: string): Promise<void>;
  markFailed(
    ownerRef: string,
    eventKey: string,
    error: string,
    availableAt: string,
    at: string,
  ): Promise<void>;
  get(ownerRef: string, eventKey: string): Promise<InboxEvent | null>;
  due(
    ownerRef: string,
    options: { readonly at: string; readonly limit?: number },
  ): Promise<readonly InboxEvent[]>;
  list(
    ownerRef: string,
    filter: {
      readonly status?: readonly InboxEvent['status'][];
      readonly topic?: string;
      readonly limit?: number;
    },
  ): Promise<readonly InboxEvent[]>;
}

export interface InboxHandler {
  (event: InboxEvent): Promise<void>;
}

export class EventInbox {
  constructor(
    private readonly store: EventInboxStore,
    private readonly options: {
      readonly now: () => Date;
      readonly maxAttempts?: number;
      readonly retryBaseMs?: number;
    },
  ) {}

  private get maxAttempts(): number {
    return this.options.maxAttempts ?? RELIABILITY_LIMITS.maxInboxAttempts;
  }

  private get retryBaseMs(): number {
    return this.options.retryBaseMs ?? RELIABILITY_LIMITS.inboxRetryBaseMs;
  }

  /**
   * Deliver one side effect. Returns what happened so a caller can report it:
   * `duplicate` and `skipped` are normal, not errors.
   */
  async deliver(input: {
    readonly ownerRef: string;
    readonly eventKey: string;
    readonly topic: string;
    readonly payload: unknown;
    readonly handle: InboxHandler;
  }): Promise<'processed' | 'duplicate' | 'failed' | 'exhausted'> {
    const at = this.options.now().toISOString();
    const fresh: InboxEvent = {
      ownerRef: input.ownerRef,
      eventKey: input.eventKey,
      topic: input.topic,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      lastError: null,
      receivedAt: at,
      processedAt: null,
      availableAt: at,
    };
    const accepted = await this.store.receive(fresh);
    if (!accepted) {
      const existing = await this.store.get(input.ownerRef, input.eventKey);
      if (existing === null) return 'duplicate';
      if (existing.status === 'processed') return 'duplicate';
      if (existing.status === 'failed' && existing.attempts >= this.maxAttempts) return 'exhausted';
      if (existing.availableAt > at) return 'duplicate';
    }
    try {
      await input.handle(fresh);
      await this.store.markProcessed(
        input.ownerRef,
        input.eventKey,
        this.options.now().toISOString(),
      );
      return 'processed';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The side effect failed.';
      const attempt = (await this.store.get(input.ownerRef, input.eventKey))?.attempts ?? 0;
      const delay = this.retryBaseMs * Math.pow(2, Math.min(attempt, 6));
      await this.store.markFailed(
        input.ownerRef,
        input.eventKey,
        message.slice(0, 500),
        new Date(this.options.now().getTime() + delay).toISOString(),
        this.options.now().toISOString(),
      );
      return 'failed';
    }
  }

  /** The owner's recorded side effects, newest first. Read-only. */
  async list(
    ownerRef: string,
    filter: {
      readonly status?: readonly InboxEvent['status'][];
      readonly topic?: string;
      readonly limit?: number;
    } = {},
  ): Promise<readonly InboxEvent[]> {
    return this.store.list(ownerRef, filter);
  }

  /** Retry what is due. One pass, bounded, so a caller controls the cadence. */
  async drain(
    ownerRef: string,
    handle: InboxHandler,
  ): Promise<{ readonly processed: number; readonly failed: number; readonly exhausted: number }> {
    const at = this.options.now().toISOString();
    const due = await this.store.due(ownerRef, { at, limit: 20 });
    let processed = 0;
    let failed = 0;
    let exhausted = 0;
    for (const event of due) {
      if (event.attempts >= this.maxAttempts) {
        exhausted += 1;
        continue;
      }
      const outcome = await this.deliver({
        ownerRef,
        eventKey: event.eventKey,
        topic: event.topic,
        payload: event.payload,
        handle,
      });
      if (outcome === 'processed') processed += 1;
      else if (outcome === 'failed') failed += 1;
      else if (outcome === 'exhausted') exhausted += 1;
    }
    return { processed, failed, exhausted };
  }
}

/** The key for a side effect: stable, and derived from its cause. */
export function eventKeyFor(topic: string, ...parts: readonly string[]): string {
  return [topic, ...parts.map((part) => part.trim())].join(':').slice(0, 300);
}
