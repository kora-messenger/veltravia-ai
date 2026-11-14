/**
 * Inbound webhooks.
 *
 * A webhook is the part of a payment system an attacker can reach without a
 * browser, so the rules here are strict and boring on purpose:
 *
 *  1. **The signature is checked before the body is parsed.** A payload that is
 *     not signed with the provider's secret is rejected and recorded as
 *     rejected, never interpreted. Parsing first would let a malformed body
 *     reach a JSON parser on an untrusted request.
 *  2. **Every delivery is recorded, including duplicates.** The row is written
 *     before anything is acted on, so a failed handler leaves evidence and a
 *     retry finds its own previous attempt.
 *  3. **Dedupe is on the provider's event id**, with a hash of the raw body as
 *     the fallback for a provider that sends no id. A duplicate delivery is
 *     recorded as `duplicate` and does nothing else.
 *  4. **Staleness is bounded.** An event whose own timestamp is older than the
 *     tolerance is refused as a replay, so an old payload replayed from a leak
 *     cannot buy a period today.
 *  5. **A webhook never names an owner.** The purchase is found by the reference
 *     this server issued, and the owner comes from that intent. A payload that
 *     mentions another workspace is data, not authority.
 */

import { createHash } from 'node:crypto';

import type { NormalizedEvent, PaymentProviderId } from './types.js';

/** How old an event's own timestamp may be before it is treated as a replay. */
export const DEFAULT_REPLAY_TOLERANCE_MS = 15 * 60 * 1000;

/**
 * A delivery's identity. The adapter builds this from the provider's event id;
 * this helper is the fallback, and it is also what a payload with no id uses.
 */
export function webhookDedupeKey(provider: PaymentProviderId, event: NormalizedEvent): string {
  if (event.eventId.trim() !== '') return event.eventId;
  const hash = createHash('sha256')
    .update(`${provider}:${event.eventType}:${JSON.stringify(event.raw)}`, 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `${provider}:${event.eventType}:hash:${hash}`;
}

export type WebhookAction = 'process' | 'ignore' | 'reject';

export interface WebhookDecision {
  readonly action: WebhookAction;
  /** Why, in words an operator reading the event row can act on. */
  readonly reason: string;
  readonly dedupeKey: string;
}

export interface DecideWebhookInput {
  readonly provider: PaymentProviderId;
  readonly event: NormalizedEvent;
  /** True when the signature check passed. A false here is always a rejection. */
  readonly signatureValid: boolean;
  readonly signatureReason?: string | null;
  readonly now: string;
  readonly toleranceMs?: number;
}

/**
 * What to do with a delivery that arrived and was parsed.
 *
 * `process` means "this may be about a payment; look up the reference and verify
 * it with the provider". Nothing is granted from the payload itself, so a forged
 * body that somehow passed a signature check still has to survive verification.
 */
export function decideWebhook(input: DecideWebhookInput): WebhookDecision {
  const dedupeKey = webhookDedupeKey(input.provider, input.event);
  if (!input.signatureValid) {
    return {
      action: 'reject',
      reason: input.signatureReason ?? 'The webhook signature did not verify.',
      dedupeKey,
    };
  }
  if (input.event.status === 'unknown') {
    return {
      action: 'ignore',
      reason: `The event "${input.event.eventType}" is not a payment outcome this build acts on.`,
      dedupeKey,
    };
  }
  if (input.event.reference === null) {
    return {
      action: 'ignore',
      reason: 'The event carries no transaction reference, so it cannot name a purchase.',
      dedupeKey,
    };
  }
  if (input.event.occurredAt !== null) {
    const occurred = Date.parse(input.event.occurredAt);
    if (!Number.isNaN(occurred)) {
      const tolerance = input.toleranceMs ?? DEFAULT_REPLAY_TOLERANCE_MS;
      if (Date.parse(input.now) - occurred > tolerance) {
        return {
          action: 'reject',
          reason: 'The event is older than the replay window, so it was not acted on.',
          dedupeKey,
        };
      }
    }
  }
  return {
    action: 'process',
    reason: 'The event names a reference this server will verify.',
    dedupeKey,
  };
}

/**
 * The outcome of acting on one delivery. Kept as data: the event row stores this
 * shape, so "processed" always has a reason beside it.
 */
export interface WebhookOutcome {
  readonly status: 'processed' | 'ignored' | 'failed' | 'duplicate' | 'rejected';
  readonly note: string;
  /** True when the caller should let the provider retry later. */
  readonly retryable: boolean;
}
