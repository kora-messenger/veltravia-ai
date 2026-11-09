/**
 * The charge lifecycle (Step 54), in one table.
 *
 * ```
 *            reserve                     commit (measured)
 *   (none) ─────────► reserved ───────────────────────────► committed ──► refunded
 *                        │                                      (wallet
 *                        ├── release (failed / cancelled) ──► released    refund)
 *                        └── expire (nobody came back) ─────► released
 *
 *   (none) ── exempt (BYOK, unbillable plan) ─────────────► exempt
 * ```
 *
 * `committed`, `released`, `exempt` and `refunded` are final for a charge row:
 * correcting money is the wallet's business (a refund or a reversal there), not
 * a rewrite here. A retry of the same interaction reuses the same row through
 * its idempotency key, so "committed" is never charged twice.
 */

import { type ChargeState, OPEN_CHARGE_STATES } from './types.js';

const TRANSITIONS: Record<ChargeState, readonly ChargeState[]> = {
  reserved: ['committed', 'released', 'exempt'],
  committed: ['refunded'],
  released: [],
  exempt: [],
  refunded: [],
};

export function canTransition(from: ChargeState, to: ChargeState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isOpenCharge(state: ChargeState): boolean {
  return OPEN_CHARGE_STATES.includes(state);
}

export function isSettledCharge(state: ChargeState): boolean {
  return !isOpenCharge(state);
}

/** Every state a charge can be in, with the meaning the docs promise. */
export const CHARGE_STATE_GUIDE: Record<ChargeState, string> = {
  reserved: 'Credit is held; the interaction has not reported usage yet.',
  committed: 'Usage was measured or priced and posted to the wallet ledger.',
  released: 'The hold was returned: the interaction failed, was cancelled or expired.',
  exempt: 'Nothing was charged on purpose (BYOK provider key or a non-billable plan).',
  refunded: 'Committed and then returned through the wallet refund path.',
};

export class MessageCreditError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'MessageCreditError';
  }
}

export function isMessageCreditError(value: unknown): value is MessageCreditError {
  return value instanceof MessageCreditError;
}
