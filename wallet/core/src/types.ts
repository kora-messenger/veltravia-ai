/**
 * Credit wallet vocabulary (Step 53).
 *
 * A wallet holds one number that matters (`available`) and two that explain it:
 * `reserved` is credit promised to work that has started but not finished, and
 * `spent` is credit that has been consumed for good. Credits are the only unit
 * for now, and the unit is written on every row anyway, so a second unit cannot
 * be introduced by quietly reinterpreting old numbers.
 *
 * The ledger is the record of what happened; the wallet is the running total of
 * it. Every entry carries its own deltas (available, reserved, spent) rather
 * than only a signed amount, because a reservation is a transaction that moves
 * credit sideways without spending it, and a refund moves credit back while
 * unspending it. With the deltas written down, `reconcile` is arithmetic anyone
 * can check instead of an argument about what the sign meant.
 */

export const WALLET_SCOPES = ['user', 'workspace'] as const;
export type WalletScope = (typeof WALLET_SCOPES)[number];

/** Deliberately closed: adding a unit is a migration, not a string change. */
export const WALLET_UNITS = ['credits'] as const;
export type WalletUnit = (typeof WALLET_UNITS)[number];

export type WalletEntryKind =
  | 'purchase'
  | 'grant'
  | 'promotion'
  | 'usage_deduction'
  | 'reservation'
  | 'reservation_commit'
  | 'reservation_release'
  | 'refund'
  | 'adjustment_credit'
  | 'adjustment_debit'
  | 'reversal';

export const WALLET_ENTRY_KINDS: readonly WalletEntryKind[] = [
  'purchase',
  'grant',
  'promotion',
  'usage_deduction',
  'reservation',
  'reservation_commit',
  'reservation_release',
  'refund',
  'adjustment_credit',
  'adjustment_debit',
  'reversal',
];

/** Who caused the entry. `system` is the platform acting on its own policy. */
export type WalletEntrySource = 'system' | 'usage' | 'operator' | 'purchase' | 'plan' | 'migration';

export interface WalletPolicy {
  /**
   * Off unless an operator turns it on. A negative balance is a credit line, so
   * it needs a deliberate decision rather than being reachable by a busy worker.
   */
  readonly allowNegative: boolean;
  /** How far below zero the wallet may go. Refused when a debit would pass it. */
  readonly negativeFloor: number;
}

export const DEFAULT_WALLET_POLICY: WalletPolicy = { allowNegative: false, negativeFloor: 0 };

export interface Wallet {
  readonly id: string;
  readonly ownerRef: string;
  readonly scope: WalletScope;
  readonly workspaceId: string | null;
  readonly unit: WalletUnit;
  /** Credit that can be spent right now. */
  readonly available: number;
  /** Credit held for work in flight. Not spendable, not yet spent. */
  readonly reserved: number;
  /** Credit consumed for good. Refunds reduce it; it is never rewritten. */
  readonly spent: number;
  readonly policy: WalletPolicy;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WalletEntry {
  readonly id: string;
  readonly seq: number;
  readonly ownerRef: string;
  readonly walletId: string;
  readonly scope: WalletScope;
  readonly workspaceId: string | null;
  readonly kind: WalletEntryKind;
  /** Positive magnitude of the movement, in `unit`. Never a sign. */
  readonly amount: number;
  readonly unit: WalletUnit;
  readonly availableDelta: number;
  readonly reservedDelta: number;
  readonly spentDelta: number;
  readonly balanceAfter: number;
  readonly reservedAfter: number;
  readonly spentAfter: number;
  readonly source: WalletEntrySource;
  readonly actor: string;
  readonly reason: string;
  readonly referenceType: string | null;
  readonly referenceId: string | null;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  /** Set on a reversal: the entry being compensated. */
  readonly reversesEntryId: string | null;
}

export const RESERVATION_STATES = ['held', 'committed', 'released', 'expired'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

export interface WalletReservation {
  readonly id: string;
  readonly ownerRef: string;
  readonly walletId: string;
  readonly amount: number;
  readonly unit: WalletUnit;
  readonly state: ReservationState;
  readonly operationKey: string;
  readonly referenceType: string | null;
  readonly referenceId: string | null;
  /** How much of the hold was actually spent when it settled. */
  readonly committedAmount: number | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

/** Hard ceilings. Exceeding one is a refusal, not a clamp. */
export const WALLET_LIMITS = {
  /** Per single entry, in credits. */
  maxEntryCredits: 1_000_000,
  /** Entries one owner may keep. Beyond this, history reads are paged off the past. */
  maxEntriesPerOwner: 100_000,
  /** Reservations a single wallet may hold at once. */
  maxOpenReservations: 500,
  historyPageSize: 100,
} as const;

export type WalletErrorCode =
  | 'INSUFFICIENT_CREDITS'
  | 'INVALID_AMOUNT'
  | 'INVALID_STATE'
  | 'NOT_FOUND'
  | 'DUPLICATE'
  | 'REFUND_EXCEEDS_ORIGINAL'
  | 'ALREADY_REVERSED'
  | 'WALLET_SCOPE_MISMATCH'
  | 'LIMIT_EXCEEDED';

/**
 * One error type for the whole wallet. `status` is what an HTTP caller gets, and
 * every refusal carries the numbers that produced it so a UI can say "you need
 * 40 more credits" instead of "failed".
 */
export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: WalletErrorCode,
    message: string,
    status: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function insufficientCredits(input: {
  readonly walletId: string;
  readonly required: number;
  readonly available: number;
  readonly unit: WalletUnit;
}): WalletError {
  const shortfall = round4(input.required - input.available);
  return new WalletError(
    'INSUFFICIENT_CREDITS',
    `This wallet needs ${round4(input.required)} ${input.unit} and has ${round4(input.available)}. Add ${shortfall} to continue.`,
    402,
    {
      walletId: input.walletId,
      required: round4(input.required),
      available: round4(input.available),
      shortfall,
      unit: input.unit,
    },
  );
}

/** Credits are money-shaped: four decimals, never a float artefact in a total. */
export function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}

export function assertAmount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WalletError('INVALID_AMOUNT', `${field} must be a finite number.`, 400, { field });
  }
  if (value <= 0) {
    throw new WalletError('INVALID_AMOUNT', `${field} must be greater than zero.`, 400, {
      field,
      value,
    });
  }
  if (value > WALLET_LIMITS.maxEntryCredits) {
    throw new WalletError(
      'LIMIT_EXCEEDED',
      `${field} is above the ${WALLET_LIMITS.maxEntryCredits} credit ceiling for one entry.`,
      400,
      { field, value, ceiling: WALLET_LIMITS.maxEntryCredits },
    );
  }
  if (round4(value) !== value) {
    throw new WalletError('INVALID_AMOUNT', `${field} may have at most four decimals.`, 400, {
      field,
      value,
    });
  }
  return value;
}

export function assertIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 200) {
    throw new WalletError(
      'INVALID_AMOUNT',
      'idempotencyKey must be a string of 8 to 200 characters, so a retry is recognisable.',
      400,
    );
  }
  return value.trim();
}
