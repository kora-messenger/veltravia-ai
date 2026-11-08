/**
 * The credit ledger and the wallet that totals it (Step 53).
 *
 * Two rules hold everywhere here:
 *
 *  1. Nothing is mutated in place. Every movement of credit is a new entry, and
 *     a mistake is fixed by a compensating entry (a refund or a reversal), never
 *     by editing the entry that was wrong. That is what makes the history worth
 *     reading.
 *  2. The balance check and the write are one step. `computeBalances` is the
 *     only place the arithmetic lives, and callers must not check a balance and
 *     then write: they ask the store to apply the deltas, and the store refuses
 *     inside the same transaction (one conditional update in PostgreSQL). A
 *     check followed by a write lets two deductions each see the same credit.
 */

import {
  DEFAULT_WALLET_POLICY,
  WalletError,
  assertAmount,
  assertIdempotencyKey,
  insufficientCredits,
  round4,
  type Wallet,
  type WalletEntry,
  type WalletEntryKind,
  type WalletEntrySource,
  type WalletPolicy,
  type WalletReservation,
  type WalletScope,
  type WalletUnit,
} from './types.js';
import {
  DEFAULT_CREDIT_RATES,
  chargeForUsage,
  isCharge,
  type BillableUsageRecord,
  type CreditRates,
  type UsageChargeSkip,
} from './pricing.js';

/** Credit deltas an entry applies. Exactly one wallet is affected. */
export interface EntryDeltas {
  readonly availableDelta: number;
  readonly reservedDelta: number;
  readonly spentDelta: number;
}

export interface EntryDraft extends EntryDeltas {
  readonly id: string;
  readonly kind: WalletEntryKind;
  readonly amount: number;
  readonly unit: WalletUnit;
  readonly source: WalletEntrySource;
  readonly actor: string;
  readonly reason: string;
  readonly referenceType: string | null;
  readonly referenceId: string | null;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly reversesEntryId: string | null;
}

export interface ApplyResult {
  readonly created: boolean;
  readonly entry: WalletEntry;
  readonly wallet: Wallet;
}

/**
 * The arithmetic, in one place. A store calls this inside its own atomic step so
 * the in-memory and database implementations can never disagree about what a
 * delta means.
 */
export function computeBalances(
  wallet: Wallet,
  deltas: EntryDeltas,
  options: { readonly allowNegative?: boolean } = {},
): Pick<Wallet, 'available' | 'reserved' | 'spent'> {
  const available = round4(wallet.available + deltas.availableDelta);
  const reserved = round4(wallet.reserved + deltas.reservedDelta);
  const spent = round4(wallet.spent + deltas.spentDelta);
  if (reserved < 0 || spent < 0) {
    throw new WalletError(
      'INVALID_STATE',
      'A wallet cannot hold or have spent a negative amount; the ledger and the balance have diverged.',
      409,
      { walletId: wallet.id, reserved, spent },
    );
  }
  const floor =
    wallet.policy.allowNegative || options.allowNegative === true
      ? -Math.abs(wallet.policy.negativeFloor)
      : 0;
  if (available < floor) {
    throw insufficientCredits({
      walletId: wallet.id,
      required: Math.abs(deltas.availableDelta),
      available: wallet.available,
      unit: wallet.unit,
    });
  }
  return { available, reserved, spent };
}

export interface WalletStore {
  getWallet(input: {
    readonly ownerRef: string;
    readonly scope: WalletScope;
    readonly workspaceId: string | null;
  }): Promise<Wallet | null>;
  createWallet(wallet: Wallet): Promise<Wallet>;
  listWallets(ownerRef: string): Promise<readonly Wallet[]>;
  /** Applies the deltas and the entry in one atomic step, or refuses. */
  apply(input: { readonly wallet: Wallet; readonly draft: EntryDraft }): Promise<ApplyResult>;
  findEntryByKey(ownerRef: string, idempotencyKey: string): Promise<WalletEntry | null>;
  findEntry(ownerRef: string, entryId: string): Promise<WalletEntry | null>;
  listEntries(
    ownerRef: string,
    filter: {
      readonly walletId?: string | null;
      readonly kinds?: readonly WalletEntryKind[];
      readonly limit: number;
      readonly beforeSeq?: number;
    },
  ): Promise<readonly WalletEntry[]>;
  countEntries(ownerRef: string): Promise<number>;
  insertReservation(reservation: WalletReservation): Promise<{
    readonly created: boolean;
    readonly reservation: WalletReservation;
  }>;
  findReservation(
    ownerRef: string,
    by: { readonly id?: string; readonly operationKey?: string },
  ): Promise<WalletReservation | null>;
  listReservations(
    ownerRef: string,
    filter: {
      readonly walletId?: string | null;
      readonly state?: WalletReservation['state'];
      readonly limit: number;
    },
  ): Promise<readonly WalletReservation[]>;
  /** Compare-and-set on state, so a hold can only settle once. */
  settleReservation(input: {
    readonly ownerRef: string;
    readonly reservationId: string;
    readonly state: 'committed' | 'released' | 'expired';
    readonly committedAmount: number | null;
    readonly settledAt: string;
  }): Promise<boolean>;
  /** Changes the policy on a wallet that already exists. Never creates one. */
  updatePolicy(wallet: Wallet): Promise<Wallet>;
  /** Credits already refunded against one entry, so a refund cannot repeat. */
  refundedTotal(ownerRef: string, entryId: string): Promise<number>;
  findReversal(ownerRef: string, entryId: string): Promise<WalletEntry | null>;
}

export interface CreditWalletOptions {
  readonly store: WalletStore;
  readonly now?: () => Date;
  readonly newId?: (prefix: string) => string;
  readonly rates?: CreditRates;
}

interface WalletRef {
  readonly ownerRef: string;
  readonly workspaceId?: string | null;
}

const WORKSPACE_SCOPE: WalletScope = 'workspace';

function defaultId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function cleanText(value: string, field: string, max = 400): string {
  const text = value.trim();
  if (text.length === 0) {
    throw new WalletError('INVALID_STATE', `${field} is required.`, 400, { field });
  }
  return text.slice(0, max);
}

export class CreditWallet {
  private readonly store: WalletStore;
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly rates: CreditRates;

  constructor(options: CreditWalletOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? defaultId;
    this.rates = options.rates ?? DEFAULT_CREDIT_RATES;
  }

  private scopeOf(ref: WalletRef): { scope: WalletScope; workspaceId: string | null } {
    const workspaceId = ref.workspaceId ?? null;
    if (workspaceId !== null && workspaceId.trim().length === 0) {
      throw new WalletError('WALLET_SCOPE_MISMATCH', 'A workspace id cannot be blank.', 400);
    }
    return workspaceId === null
      ? { scope: 'user', workspaceId: null }
      : { scope: WORKSPACE_SCOPE, workspaceId };
  }

  /** Opens a wallet if it is not there yet, and returns the one that is. */
  async ensureWallet(
    ref: WalletRef & { readonly policy?: Partial<WalletPolicy> },
  ): Promise<Wallet> {
    const { scope, workspaceId } = this.scopeOf(ref);
    const existing = await this.store.getWallet({
      ownerRef: ref.ownerRef,
      scope,
      workspaceId,
    });
    if (existing !== null) return existing;
    const stamp = this.now().toISOString();
    const policy: WalletPolicy = {
      allowNegative: ref.policy?.allowNegative ?? DEFAULT_WALLET_POLICY.allowNegative,
      negativeFloor: ref.policy?.negativeFloor ?? DEFAULT_WALLET_POLICY.negativeFloor,
    };
    const wallet: Wallet = {
      id: this.newId(scope === 'workspace' ? 'walw' : 'walu'),
      ownerRef: ref.ownerRef,
      scope,
      workspaceId,
      unit: 'credits',
      available: 0,
      reserved: 0,
      spent: 0,
      policy,
      version: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    // A concurrent create is not an error: both callers want the same wallet.
    return this.store.createWallet(wallet);
  }

  async wallet(ref: WalletRef): Promise<Wallet | null> {
    const { scope, workspaceId } = this.scopeOf(ref);
    return this.store.getWallet({ ownerRef: ref.ownerRef, scope, workspaceId });
  }

  private async requireWallet(ref: WalletRef): Promise<Wallet> {
    const wallet = await this.wallet(ref);
    if (wallet === null) {
      throw new WalletError(
        'NOT_FOUND',
        'No wallet exists yet for this owner. Open one before moving credit.',
        404,
        { scope: ref.workspaceId ? 'workspace' : 'user' },
      );
    }
    return wallet;
  }

  private async apply(
    wallet: Wallet,
    draft: Omit<EntryDraft, 'id' | 'occurredAt' | 'unit'> & { readonly unit?: WalletUnit },
  ): Promise<ApplyResult> {
    const entry: EntryDraft = {
      ...draft,
      unit: draft.unit ?? wallet.unit,
      id: this.newId('wle'),
      occurredAt: this.now().toISOString(),
    };
    let attempt = wallet;
    for (let retries = 0; ; retries += 1) {
      try {
        return await this.store.apply({ wallet: attempt, draft: entry });
      } catch (error) {
        // A wallet that moved under us is not a failure, it is a stale read: the
        // deltas are still correct, they just have to be applied to the balance
        // that exists now. Anything else - insufficient credit above all - is a
        // real refusal and is never retried.
        const stale =
          error instanceof WalletError &&
          error.code === 'INVALID_STATE' &&
          typeof error.details.actualVersion === 'number';
        if (!stale || retries >= 5) throw error;
        const fresh = await this.store.getWallet({
          ownerRef: attempt.ownerRef,
          scope: attempt.scope,
          workspaceId: attempt.workspaceId,
        });
        if (fresh === null) throw error;
        attempt = fresh;
      }
    }
  }

  /** Adds credit: a purchase, an included grant, a promotion or a correction. */
  async credit(
    input: WalletRef & {
      readonly amount: number;
      readonly kind: 'purchase' | 'grant' | 'promotion' | 'adjustment_credit';
      readonly source: WalletEntrySource;
      readonly actor: string;
      readonly reason: string;
      readonly idempotencyKey: string;
      readonly referenceType?: string | null;
      readonly referenceId?: string | null;
    },
  ): Promise<ApplyResult> {
    const amount = assertAmount(input.amount, 'amount');
    const key = assertIdempotencyKey(input.idempotencyKey);
    const wallet = await this.requireWallet(input);
    return this.apply(wallet, {
      availableDelta: amount,
      reservedDelta: 0,
      spentDelta: 0,
      amount,
      kind: input.kind,
      source: input.source,
      actor: cleanText(input.actor, 'actor', 120),
      reason: cleanText(input.reason, 'reason'),
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      idempotencyKey: key,
      reversesEntryId: null,
    });
  }

  /** Takes credit for work that has already happened. Atomic, or refused. */
  async charge(
    input: WalletRef & {
      readonly amount: number;
      readonly source: WalletEntrySource;
      readonly actor: string;
      readonly reason: string;
      readonly idempotencyKey: string;
      readonly referenceType?: string | null;
      readonly referenceId?: string | null;
    },
  ): Promise<ApplyResult> {
    const amount = assertAmount(input.amount, 'amount');
    const key = assertIdempotencyKey(input.idempotencyKey);
    const wallet = await this.requireWallet(input);
    return this.apply(wallet, {
      availableDelta: -amount,
      reservedDelta: 0,
      spentDelta: amount,
      amount,
      kind: 'usage_deduction',
      source: input.source,
      actor: cleanText(input.actor, 'actor', 120),
      reason: cleanText(input.reason, 'reason'),
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      idempotencyKey: key,
      reversesEntryId: null,
    });
  }

  /** Holds credit for work that is about to start. Not spent yet. */
  async reserve(
    input: WalletRef & {
      readonly amount: number;
      readonly operationKey: string;
      readonly reason: string;
      readonly actor: string;
      readonly referenceType?: string | null;
      readonly referenceId?: string | null;
      readonly ttlSeconds?: number;
    },
  ): Promise<{
    readonly reservation: WalletReservation;
    readonly entry: WalletEntry;
    readonly wallet: Wallet;
  }> {
    const amount = assertAmount(input.amount, 'amount');
    const operationKey = assertIdempotencyKey(input.operationKey);
    const wallet = await this.requireWallet(input);

    const existing = await this.store.findReservation(input.ownerRef, { operationKey });
    if (existing !== null) {
      // Replaying a reservation returns the hold that exists: the work it was
      // taken for must not be funded twice.
      return {
        reservation: existing,
        entry: (await this.store.findEntryByKey(
          input.ownerRef,
          `reserve:${operationKey}`,
        )) as WalletEntry,
        wallet: (await this.wallet(input)) as Wallet,
      };
    }

    const applied = await this.apply(wallet, {
      availableDelta: -amount,
      reservedDelta: amount,
      spentDelta: 0,
      amount,
      kind: 'reservation',
      source: 'system',
      actor: cleanText(input.actor, 'actor', 120),
      reason: cleanText(input.reason, 'reason'),
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      idempotencyKey: `reserve:${operationKey}`,
      reversesEntryId: null,
    });

    const ttl = Math.min(Math.max(input.ttlSeconds ?? 1_800, 60), 86_400);
    const stamp = new Date(this.now().getTime() + ttl * 1_000).toISOString();
    const reservation: WalletReservation = {
      id: this.newId('wlr'),
      ownerRef: input.ownerRef,
      walletId: wallet.id,
      amount,
      unit: wallet.unit,
      state: 'held',
      operationKey,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      committedAmount: null,
      expiresAt: stamp,
      createdAt: this.now().toISOString(),
      settledAt: null,
    };
    const inserted = await this.store.insertReservation(reservation);
    return { reservation: inserted.reservation, entry: applied.entry, wallet: applied.wallet };
  }

  /**
   * Settles a hold: `amount` (at most the hold) becomes spent, and the rest goes
   * back to available. One call per hold, ever.
   */
  async commitReservation(
    input: WalletRef & {
      readonly reservationId?: string;
      readonly operationKey?: string;
      readonly amount?: number;
      readonly reason: string;
      readonly actor: string;
    },
  ): Promise<ApplyResult & { readonly reservation: WalletReservation }> {
    const reservation = await this.reservationFor(input);
    if (reservation.state !== 'held') {
      throw new WalletError(
        'INVALID_STATE',
        `This hold is already ${reservation.state}; it cannot be settled again.`,
        409,
        { reservationId: reservation.id, state: reservation.state },
      );
    }
    const spend =
      input.amount === undefined ? reservation.amount : assertAmount(input.amount, 'amount');
    if (spend > reservation.amount) {
      throw new WalletError(
        'INVALID_AMOUNT',
        `A hold of ${reservation.amount} cannot settle at ${spend}.`,
        400,
        { reserved: reservation.amount, requested: spend },
      );
    }
    const wallet = await this.requireWallet(input);
    const settle = await this.store.settleReservation({
      ownerRef: input.ownerRef,
      reservationId: reservation.id,
      state: 'committed',
      committedAmount: spend,
      settledAt: this.now().toISOString(),
    });
    if (!settle) {
      throw new WalletError('INVALID_STATE', 'Another request settled this hold first.', 409, {
        reservationId: reservation.id,
      });
    }
    // The whole hold leaves `reserved`; what was not spent comes back as
    // available. availableDelta + reservedDelta + spentDelta is always zero,
    // which is what keeps the total the same size.
    const release = round4(reservation.amount - spend);
    const applied = await this.apply(wallet, {
      availableDelta: release,
      reservedDelta: -reservation.amount,
      spentDelta: spend,
      amount: spend,
      kind: 'reservation_commit',
      source: 'system',
      actor: cleanText(input.actor, 'actor', 120),
      reason: cleanText(input.reason, 'reason'),
      referenceType: reservation.referenceType,
      referenceId: reservation.referenceId ?? reservation.id,
      idempotencyKey: `commit:${reservation.id}`,
      reversesEntryId: null,
    });
    return {
      ...applied,
      reservation: { ...reservation, state: 'committed', committedAmount: spend },
    };
  }

  /** Gives a held amount back without charging for it. */
  async releaseReservation(
    input: WalletRef & {
      readonly reservationId?: string;
      readonly operationKey?: string;
      readonly reason: string;
      readonly actor: string;
    },
  ): Promise<ApplyResult & { readonly reservation: WalletReservation }> {
    return this.settleHold(input, 'released');
  }

  /** Holds nobody settled are cleared by this, with the same release entry. */
  async expireReservation(
    input: WalletRef & { readonly reservationId: string; readonly actor?: string },
  ): Promise<ApplyResult & { readonly reservation: WalletReservation }> {
    return this.settleHold(
      {
        ...input,
        actor: input.actor ?? 'system',
        reason: 'The reservation passed its expiry without being settled.',
      },
      'expired',
    );
  }

  private async settleHold(
    input: WalletRef & {
      readonly reservationId?: string;
      readonly operationKey?: string;
      readonly reason: string;
      readonly actor: string;
    },
    state: 'released' | 'expired',
  ): Promise<ApplyResult & { readonly reservation: WalletReservation }> {
    const reservation = await this.reservationFor(input);
    if (reservation.state !== 'held') {
      throw new WalletError(
        'INVALID_STATE',
        `This hold is already ${reservation.state}; it cannot be released again.`,
        409,
        { reservationId: reservation.id, state: reservation.state },
      );
    }
    const wallet = await this.requireWallet(input);
    const settled = await this.store.settleReservation({
      ownerRef: input.ownerRef,
      reservationId: reservation.id,
      state,
      committedAmount: null,
      settledAt: this.now().toISOString(),
    });
    if (!settled) {
      throw new WalletError('INVALID_STATE', 'Another request settled this hold first.', 409, {
        reservationId: reservation.id,
      });
    }
    const applied = await this.apply(wallet, {
      availableDelta: reservation.amount,
      reservedDelta: -reservation.amount,
      spentDelta: 0,
      amount: reservation.amount,
      kind: 'reservation_release',
      source: 'system',
      actor: cleanText(input.actor, 'actor', 120),
      reason: cleanText(input.reason, 'reason'),
      referenceType: reservation.referenceType,
      referenceId: reservation.referenceId ?? reservation.id,
      idempotencyKey: `release:${reservation.id}`,
      reversesEntryId: null,
    });
    return { ...applied, reservation: { ...reservation, state } };
  }

  private async reservationFor(
    input: WalletRef & { readonly reservationId?: string; readonly operationKey?: string },
  ): Promise<WalletReservation> {
    if (input.reservationId === undefined && input.operationKey === undefined) {
      throw new WalletError(
        'INVALID_STATE',
        'Name the hold to settle, either by id or by the operation key it was taken under.',
        400,
      );
    }
    const found = await this.store.findReservation(input.ownerRef, {
      ...(input.reservationId !== undefined ? { id: input.reservationId } : {}),
      ...(input.operationKey !== undefined ? { operationKey: input.operationKey } : {}),
    });
    if (found === null) {
      throw new WalletError('NOT_FOUND', 'No such hold exists for this wallet.', 404, {
        reservationId: input.reservationId ?? null,
        operationKey: input.operationKey ?? null,
      });
    }
    return found;
  }

  /**
   * Gives credit back for a charge, once. The refund points at the entry it
   * compensates, and the total refunded against that entry can never exceed what
   * it charged.
   */
  async refund(
    input: WalletRef & {
      readonly entryId: string;
      readonly amount?: number;
      readonly reason: string;
      readonly actor: string;
      readonly idempotencyKey: string;
    },
  ): Promise<ApplyResult> {
    const duplicate = await this.store.findEntryByKey(
      input.ownerRef,
      assertIdempotencyKey(input.idempotencyKey),
    );
    if (duplicate !== null) {
      // A retried refund is the same refund, not a second one.
      return { created: false, entry: duplicate, wallet: await this.requireWallet(input) };
    }
    const original = await this.store.findEntry(input.ownerRef, input.entryId);
    if (original === null) {
      throw new WalletError('NOT_FOUND', 'No such transaction exists for this owner.', 404, {
        entryId: input.entryId,
      });
    }
    if (original.spentDelta <= 0) {
      throw new WalletError(
        'INVALID_STATE',
        'Only a transaction that spent credit can be refunded.',
        409,
        { entryId: original.id, kind: original.kind },
      );
    }
    const already = await this.store.refundedTotal(input.ownerRef, original.id);
    const remaining = round4(original.spentDelta - already);
    if (input.amount === undefined && remaining <= 0) {
      throw new WalletError(
        'REFUND_EXCEEDS_ORIGINAL',
        'That charge has already been refunded in full; there is nothing left to return.',
        409,
        { entryId: original.id, charged: original.spentDelta, refunded: already },
      );
    }
    const amount = input.amount === undefined ? remaining : assertAmount(input.amount, 'amount');
    if (already + amount > original.spentDelta + 0.00005) {
      throw new WalletError(
        'REFUND_EXCEEDS_ORIGINAL',
        `That charge was ${original.spentDelta} and ${already} has already been refunded.`,
        409,
        {
          entryId: original.id,
          charged: original.spentDelta,
          refunded: already,
          requested: amount,
        },
      );
    }
    const wallet = await this.requireWallet(input);
    return this.apply(wallet, {
      availableDelta: amount,
      reservedDelta: 0,
      spentDelta: -amount,
      amount,
      kind: 'refund',
      source: 'operator',
      actor: cleanText(input.actor, 'actor', 120),
      reason: cleanText(input.reason, 'reason'),
      referenceType: 'entry',
      referenceId: original.id,
      idempotencyKey: assertIdempotencyKey(input.idempotencyKey),
      reversesEntryId: null,
    });
  }

  /**
   * Reverses one entry completely, by writing its opposite. Separate from a
   * refund because a reversal is for a mistake (wrong wallet, wrong amount) and
   * is exact; a refund is for a decision.
   */
  async reverse(
    input: WalletRef & {
      readonly entryId: string;
      readonly reason: string;
      readonly actor: string;
      readonly idempotencyKey?: string;
    },
  ): Promise<ApplyResult> {
    const original = await this.store.findEntry(input.ownerRef, input.entryId);
    if (original === null) {
      throw new WalletError('NOT_FOUND', 'No such transaction exists for this owner.', 404, {
        entryId: input.entryId,
      });
    }
    if (original.kind === 'reversal' || original.reversesEntryId !== null) {
      throw new WalletError('ALREADY_REVERSED', 'A reversal cannot itself be reversed.', 409, {
        entryId: original.id,
      });
    }
    const existing = await this.store.findReversal(input.ownerRef, original.id);
    if (existing !== null) {
      throw new WalletError(
        'ALREADY_REVERSED',
        'That transaction has already been reversed.',
        409,
        { entryId: original.id, reversalId: existing.id },
      );
    }
    const wallet = await this.requireWallet(input);
    return this.apply(wallet, {
      availableDelta: -original.availableDelta,
      reservedDelta: -original.reservedDelta,
      spentDelta: -original.spentDelta,
      amount: original.amount,
      kind: 'reversal',
      source: 'operator',
      actor: cleanText(input.actor, 'actor', 120),
      reason: cleanText(input.reason, 'reason'),
      referenceType: 'entry',
      referenceId: original.id,
      idempotencyKey: assertIdempotencyKey(input.idempotencyKey ?? `reversal:${original.id}`),
      reversesEntryId: original.id,
    });
  }

  /** An operator correction. Signed, reasoned, and never silent. */
  async adjust(
    input: WalletRef & {
      readonly amount: number;
      readonly direction: 'credit' | 'debit';
      readonly reason: string;
      readonly actor: string;
      readonly idempotencyKey: string;
      readonly referenceType?: string | null;
      readonly referenceId?: string | null;
    },
  ): Promise<ApplyResult> {
    const amount = assertAmount(input.amount, 'amount');
    const wallet = await this.requireWallet(input);
    const credit = input.direction === 'credit';
    return this.apply(wallet, {
      availableDelta: credit ? amount : -amount,
      reservedDelta: 0,
      spentDelta: 0,
      amount,
      kind: credit ? 'adjustment_credit' : 'adjustment_debit',
      source: 'operator',
      actor: cleanText(input.actor, 'actor', 120),
      reason: cleanText(input.reason, 'reason'),
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      idempotencyKey: assertIdempotencyKey(input.idempotencyKey),
      reversesEntryId: null,
    });
  }

  /**
   * Turns a metered usage record into a credit charge, once per record.
   *
   * The idempotency key is derived from the usage record's own `operationKey`,
   * which the meter already makes unique per operation. That is what stops a
   * retried worker or a replayed request being charged twice, and it is why this
   * method never takes a caller-supplied key.
   */
  async chargeUsage(
    input: WalletRef & {
      readonly record: BillableUsageRecord;
      readonly actor?: string;
    },
  ): Promise<
    | { readonly charged: ApplyResult; readonly skip?: never }
    | { readonly charged?: never; readonly skip: UsageChargeSkip }
  > {
    const charge = chargeForUsage(input.record, this.ratesFromEnv());
    if (!isCharge(charge)) return { skip: charge };
    const applied = await this.charge({
      ...input,
      amount: charge.credits,
      source: 'usage',
      actor: input.actor ?? 'usage-meter',
      reason: `${charge.category} ${charge.quantity} ${input.record.unit} at ${charge.rate.credits} credits per ${charge.rate.per} (${charge.rateVersion}).`,
      idempotencyKey: `usage:${input.record.operationKey}`,
      referenceType: 'usage_record',
      referenceId: input.record.operationKey,
    });
    return { charged: applied };
  }

  /** Refuses at the door, so work is never started on credit that is not there. */
  async assertAffordable(input: WalletRef & { readonly amount: number }): Promise<void> {
    const wallet = await this.requireWallet(input);
    const amount = assertAmount(input.amount, 'amount');
    const floor = wallet.policy.allowNegative ? -Math.abs(wallet.policy.negativeFloor) : 0;
    if (wallet.available - amount < floor) {
      throw insufficientCredits({
        walletId: wallet.id,
        required: amount,
        available: wallet.available,
        unit: wallet.unit,
      });
    }
  }

  /**
   * Turns the credit line on or off. A policy change is never silent: it is
   * operator work, it is stamped on the wallet, and the `version` moves so a
   * balance computed before the change cannot be applied after it.
   */
  async setPolicy(
    input: WalletRef & {
      readonly allowNegative: boolean;
      readonly negativeFloor: number;
      readonly actor: string;
    },
  ): Promise<Wallet> {
    const current = await this.requireWallet(input);
    return this.store.updatePolicy({
      ...current,
      policy: {
        allowNegative: input.allowNegative,
        negativeFloor: Math.max(0, input.negativeFloor),
      },
      version: current.version + 1,
      updatedAt: this.now().toISOString(),
    });
  }

  /** Proves the stored balances are the sum of the ledger, for one wallet. */
  async reconcile(ref: WalletRef): Promise<{
    readonly walletId: string;
    readonly consistent: boolean;
    readonly entries: number;
    readonly ledger: { available: number; reserved: number; spent: number };
    readonly stored: { available: number; reserved: number; spent: number };
    readonly problems: readonly string[];
  }> {
    const wallet = await this.requireWallet(ref);
    const entries = await this.store.listEntries(ref.ownerRef, {
      walletId: wallet.id,
      limit: 100_000,
    });
    let available = 0;
    let reserved = 0;
    let spent = 0;
    for (const entry of entries) {
      available += entry.availableDelta;
      reserved += entry.reservedDelta;
      spent += entry.spentDelta;
    }
    const ledger = {
      available: round4(available),
      reserved: round4(reserved),
      spent: round4(spent),
    };
    const problems: string[] = [];
    if (ledger.available !== round4(wallet.available)) {
      problems.push(
        `available is stored as ${wallet.available} but the ledger adds up to ${ledger.available}`,
      );
    }
    if (ledger.reserved !== round4(wallet.reserved)) {
      problems.push(
        `reserved is stored as ${wallet.reserved} but the ledger adds up to ${ledger.reserved}`,
      );
    }
    if (ledger.spent !== round4(wallet.spent)) {
      problems.push(`spent is stored as ${wallet.spent} but the ledger adds up to ${ledger.spent}`);
    }
    const last = entries.reduce((max, entry) => (entry.seq > max ? entry.seq : max), 0);
    const highestAfterLast = entries
      .filter((entry) => entry.seq === last)
      .map((entry) => entry.balanceAfter);
    if (highestAfterLast.length > 0 && highestAfterLast[0] !== round4(wallet.available)) {
      problems.push(
        `the last entry left ${highestAfterLast[0]} available, the wallet says ${wallet.available}`,
      );
    }
    return {
      walletId: wallet.id,
      consistent: problems.length === 0,
      entries: entries.length,
      ledger,
      stored: { available: wallet.available, reserved: wallet.reserved, spent: wallet.spent },
      problems,
    };
  }

  async history(
    ref: WalletRef & {
      readonly limit?: number;
      readonly kinds?: readonly WalletEntryKind[];
      readonly beforeSeq?: number;
    },
  ): Promise<readonly WalletEntry[]> {
    const wallet = await this.requireWallet(ref);
    const limit = Math.min(Math.max(ref.limit ?? 25, 1), 100);
    return this.store.listEntries(ref.ownerRef, {
      walletId: wallet.id,
      limit,
      ...(ref.kinds === undefined ? {} : { kinds: ref.kinds }),
      ...(ref.beforeSeq === undefined ? {} : { beforeSeq: ref.beforeSeq }),
    });
  }

  async reservations(
    ref: WalletRef & { readonly limit?: number },
  ): Promise<readonly WalletReservation[]> {
    const wallet = await this.requireWallet(ref);
    return this.store.listReservations(ref.ownerRef, {
      walletId: wallet.id,
      state: 'held',
      limit: Math.min(Math.max(ref.limit ?? 25, 1), 100),
    });
  }

  private ratesFromEnv(): CreditRates {
    return this.rates;
  }
}
