/**
 * The credit wallet service (Step 53).
 *
 * This is the only place the API decides what a wallet may do. It wraps
 * `@veltravia/wallet-core` with the deployment's stores, the configuration, and
 * the audit vocabulary, and it is the seam the usage meter calls when a metered
 * event becomes a charge.
 *
 * Three decisions are worth reading before changing anything here:
 *
 *  1. **A read opens the wallet.** An owner with no wallet gets an empty one on
 *     their first balance read, so the dashboard shows "0 credits" rather than a
 *     404 that looks like a broken account.
 *  2. **Billing is a hook, not a second meter.** The usage service calls
 *     `billUsage` after it has written a record, and the charge is keyed on the
 *     record's own operation key, so the same event cannot be charged twice even
 *     if the hook runs twice. A metering failure never turns completed work into
 *     an error: the charge is best-effort and the ledger records what it managed.
 *  3. **An operator is not a client.** Credits, adjustments, refunds, reversals
 *     and policy changes are operator work and take an actor name that is written
 *     into the entry. A caller cannot top up their own balance.
 */

import {
  CreditWallet,
  InMemoryWalletStore,
  WalletError,
  describeRates,
  isCharge,
  parseCreditRates,
  chargeForUsage,
  type BillableUsageRecord,
  type CreditRates,
  type WalletEntryKind,
  type WalletPolicy,
  type WalletReservation,
  type WalletStore,
  type Wallet,
  type WalletEntry,
} from '@veltravia/wallet-core';

export interface WalletServiceOptions {
  /** Durable store when the deployment has a database. */
  readonly store?: WalletStore | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface WalletView {
  readonly id: string;
  readonly scope: 'user' | 'workspace';
  readonly workspaceId: string | null;
  readonly unit: 'credits';
  readonly available: number;
  readonly reserved: number;
  readonly spent: number;
  /** available - reserved is what is actually spendable; kept explicit. */
  readonly spendable: number;
  readonly currency: 'VELTRAVIA_CREDITS';
  readonly policy: WalletPolicy;
  readonly updatedAt: string;
}

export interface WalletOverview {
  readonly durable: boolean;
  readonly wallet: WalletView;
  readonly held: readonly WalletReservation[];
  readonly recent: readonly WalletEntry[];
  readonly rates: {
    readonly version: string;
    readonly rates: readonly string[];
    readonly note: string;
  };
  readonly note: string;
}

function toView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    scope: wallet.scope,
    workspaceId: wallet.workspaceId,
    unit: wallet.unit,
    available: wallet.available,
    reserved: wallet.reserved,
    spent: wallet.spent,
    spendable: Math.round((wallet.available - wallet.reserved) * 10_000) / 10_000,
    currency: 'VELTRAVIA_CREDITS',
    policy: wallet.policy,
    updatedAt: wallet.updatedAt,
  };
}

export function walletHttpStatus(error: unknown): number {
  if (error instanceof WalletError) return error.status;
  return 500;
}

export interface WalletService {
  readonly durable: boolean;
  readonly rates: CreditRates;
  ensure(ref: { ownerRef: string; workspaceId?: string | null }): Promise<WalletView>;
  overview(ref: {
    ownerRef: string;
    workspaceId?: string | null;
    limit?: number;
  }): Promise<WalletOverview>;
  history(ref: {
    ownerRef: string;
    workspaceId?: string | null;
    limit?: number;
    kinds?: readonly WalletEntryKind[];
    beforeSeq?: number;
  }): Promise<readonly WalletEntry[]>;
  held(ref: {
    ownerRef: string;
    workspaceId?: string | null;
  }): Promise<readonly WalletReservation[]>;
  reserve(input: {
    ownerRef: string;
    workspaceId?: string | null;
    amount: number;
    operationKey: string;
    reason: string;
    actor: string;
    referenceType?: string | null;
    referenceId?: string | null;
    ttlSeconds?: number;
  }): Promise<{ reservation: WalletReservation; wallet: WalletView }>;
  release(input: {
    ownerRef: string;
    workspaceId?: string | null;
    reservationId: string;
    reason: string;
    actor: string;
  }): Promise<{ reservation: WalletReservation; wallet: WalletView }>;
  commit(input: {
    ownerRef: string;
    workspaceId?: string | null;
    reservationId: string;
    amount?: number;
    reason: string;
    actor: string;
  }): Promise<{ reservation: WalletReservation; wallet: WalletView; entry: WalletEntry }>;
  credit(input: {
    ownerRef: string;
    workspaceId?: string | null;
    amount: number;
    kind: 'purchase' | 'grant' | 'promotion';
    reason: string;
    actor: string;
    idempotencyKey: string;
    referenceType?: string | null;
    referenceId?: string | null;
  }): Promise<{ wallet: WalletView; entry: WalletEntry; created: boolean }>;
  adjust(input: {
    ownerRef: string;
    workspaceId?: string | null;
    amount: number;
    direction: 'credit' | 'debit';
    reason: string;
    actor: string;
    idempotencyKey: string;
  }): Promise<{ wallet: WalletView; entry: WalletEntry; created: boolean }>;
  refund(input: {
    ownerRef: string;
    workspaceId?: string | null;
    entryId: string;
    amount?: number;
    reason: string;
    actor: string;
    idempotencyKey: string;
  }): Promise<{ wallet: WalletView; entry: WalletEntry; created: boolean }>;
  reverse(input: {
    ownerRef: string;
    workspaceId?: string | null;
    entryId: string;
    reason: string;
    actor: string;
    idempotencyKey?: string;
  }): Promise<{ wallet: WalletView; entry: WalletEntry; created: boolean }>;
  setPolicy(input: {
    ownerRef: string;
    workspaceId?: string | null;
    allowNegative: boolean;
    negativeFloor: number;
    actor: string;
  }): Promise<WalletView>;
  reconcile(ref: {
    ownerRef: string;
    workspaceId?: string | null;
  }): Promise<Awaited<ReturnType<CreditWallet['reconcile']>>>;
  /** Turns one metered event into a charge, at most once. */
  billUsage(input: {
    ownerRef: string;
    workspaceId?: string | null;
    record: BillableUsageRecord;
  }): Promise<{ charged: boolean; credits: number; reason: string }>;
  /** What a metered record would cost, without charging it. */
  previewUsage(record: BillableUsageRecord): { credits: number } | { skipped: string };
  capabilities(): {
    readonly durable: boolean;
    readonly currency: 'VELTRAVIA_CREDITS';
    readonly unit: 'credits';
    readonly rateVersion: string;
    readonly rates: readonly string[];
    readonly rules: readonly string[];
    readonly limits: readonly string[];
  };
}

export function createWalletService(options: WalletServiceOptions = {}): WalletService {
  const env = options.env ?? process.env;
  const durable = options.store !== undefined;
  const store = options.store ?? new InMemoryWalletStore();
  const rates = parseCreditRates(env.VELTRAVIA_CREDIT_RATES);
  const wallet = new CreditWallet({
    store,
    rates,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const refOf = (input: { ownerRef: string; workspaceId?: string | null }) => ({
    ownerRef: input.ownerRef,
    workspaceId: input.workspaceId ?? null,
  });

  async function ensure(ref: {
    ownerRef: string;
    workspaceId?: string | null;
  }): Promise<WalletView> {
    return toView(await wallet.ensureWallet(refOf(ref)));
  }

  async function reload(ref: {
    ownerRef: string;
    workspaceId?: string | null;
  }): Promise<WalletView> {
    const current = await wallet.wallet(refOf(ref));
    return toView(current ?? (await wallet.ensureWallet(refOf(ref))));
  }

  return {
    durable,
    rates,

    ensure,

    async overview(ref) {
      const current = await ensure(ref);
      const [held, recent] = await Promise.all([
        wallet.reservations({ ...refOf(ref), limit: 10 }),
        wallet.history({ ...refOf(ref), limit: Math.min(ref.limit ?? 10, 50) }),
      ]);
      return {
        durable,
        wallet: current,
        held,
        recent,
        rates: {
          version: 'veltravia-credits-2026-11',
          rates: describeRates(rates),
          note: 'These are documented defaults, configurable per deployment with VELTRAVIA_CREDIT_RATES. A charge records the rate it was made at, so changing a rate never rewrites history.',
        },
        note: durable
          ? 'Balances are stored in the database and survive a restart.'
          : 'This deployment keeps wallets in memory; balances reset when the server restarts.',
      };
    },

    async history(ref) {
      return wallet.history({
        ...refOf(ref),
        ...(ref.limit === undefined ? {} : { limit: ref.limit }),
        ...(ref.kinds === undefined ? {} : { kinds: ref.kinds }),
        ...(ref.beforeSeq === undefined ? {} : { beforeSeq: ref.beforeSeq }),
      });
    },

    async held(ref) {
      return wallet.reservations(refOf(ref));
    },

    async reserve(input) {
      // A first-time owner has no row yet; opening it here means a refusal says
      // what is missing (credits, a hold) instead of claiming the account does
      // not exist.
      await ensure(input);
      const result = await wallet.reserve({
        ...refOf(input),
        amount: input.amount,
        operationKey: input.operationKey,
        reason: input.reason,
        actor: input.actor,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
      });
      return { reservation: result.reservation, wallet: await reload(input) };
    },

    async release(input) {
      // A first-time owner has no row yet; opening it here means a refusal says
      // what is missing (credits, a hold) instead of claiming the account does
      // not exist.
      await ensure(input);
      const result = await wallet.releaseReservation({
        ...refOf(input),
        reservationId: input.reservationId,
        reason: input.reason,
        actor: input.actor,
      });
      return { reservation: result.reservation, wallet: await reload(input) };
    },

    async commit(input) {
      // A first-time owner has no row yet; opening it here means a refusal says
      // what is missing (credits, a hold) instead of claiming the account does
      // not exist.
      await ensure(input);
      const result = await wallet.commitReservation({
        ...refOf(input),
        reservationId: input.reservationId,
        reason: input.reason,
        actor: input.actor,
        ...(input.amount === undefined ? {} : { amount: input.amount }),
      });
      return {
        reservation: result.reservation,
        wallet: await reload(input),
        entry: result.entry,
      };
    },

    async credit(input) {
      // A first-time owner has no row yet; opening it here means a refusal says
      // what is missing (credits, a hold) instead of claiming the account does
      // not exist.
      await ensure(input);
      const result = await wallet.credit({
        ...refOf(input),
        amount: input.amount,
        kind: input.kind,
        source: input.kind === 'purchase' ? 'purchase' : 'operator',
        actor: input.actor,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
      });
      return { wallet: await reload(input), entry: result.entry, created: result.created };
    },

    async adjust(input) {
      // A first-time owner has no row yet; opening it here means a refusal says
      // what is missing (credits, a hold) instead of claiming the account does
      // not exist.
      await ensure(input);
      const result = await wallet.adjust({
        ...refOf(input),
        amount: input.amount,
        direction: input.direction,
        reason: input.reason,
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
      });
      return { wallet: await reload(input), entry: result.entry, created: result.created };
    },

    async refund(input) {
      // A first-time owner has no row yet; opening it here means a refusal says
      // what is missing (credits, a hold) instead of claiming the account does
      // not exist.
      await ensure(input);
      const result = await wallet.refund({
        ...refOf(input),
        entryId: input.entryId,
        reason: input.reason,
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        ...(input.amount === undefined ? {} : { amount: input.amount }),
      });
      return { wallet: await reload(input), entry: result.entry, created: result.created };
    },

    async reverse(input) {
      // A first-time owner has no row yet; opening it here means a refusal says
      // what is missing (credits, a hold) instead of claiming the account does
      // not exist.
      await ensure(input);
      const result = await wallet.reverse({
        ...refOf(input),
        entryId: input.entryId,
        reason: input.reason,
        actor: input.actor,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      });
      return { wallet: await reload(input), entry: result.entry, created: result.created };
    },

    async setPolicy(input) {
      const saved = await wallet.setPolicy({
        ...refOf(input),
        allowNegative: input.allowNegative,
        negativeFloor: input.negativeFloor,
        actor: input.actor,
      });
      return toView(saved);
    },

    async reconcile(ref) {
      return wallet.reconcile(refOf(ref));
    },

    async billUsage(input) {
      const charge = chargeForUsage(input.record, rates);
      if (!isCharge(charge)) {
        return { charged: false, credits: 0, reason: charge.detail };
      }
      try {
        const result = await wallet.chargeUsage({
          ...refOf(input),
          record: input.record,
          actor: 'usage-meter',
        });
        if (result.skip !== undefined) {
          return { charged: false, credits: 0, reason: result.skip.detail };
        }
        return {
          charged: result.charged.created,
          credits: charge.credits,
          reason: result.charged.created
            ? 'Charged from the metered event.'
            : 'This event had already been charged; the existing entry was kept.',
        };
      } catch (error) {
        // A wallet that cannot pay does not undo work that already ran. The
        // refusal is reported to the caller (the meter logs it) and the next
        // billing pass sees the same usage record still uncharged.
        if (error instanceof WalletError) {
          return { charged: false, credits: charge.credits, reason: error.message };
        }
        throw error;
      }
    },

    previewUsage(record) {
      const charge = chargeForUsage(record, rates);
      return isCharge(charge) ? { credits: charge.credits } : { skipped: charge.detail };
    },

    capabilities() {
      return {
        durable,
        currency: 'VELTRAVIA_CREDITS',
        unit: 'credits',
        rateVersion: 'veltravia-credits-2026-11',
        rates: describeRates(rates),
        rules: [
          'A metered event is charged once. The charge is keyed on the meter’s own operation key, so a retried worker or a replayed request cannot be billed twice.',
          'Usage paid for with your own provider key is never converted into Veltravia credits: that spend is between you and the provider.',
          'A category with no configured rate charges nothing, and the rate table says so rather than guessing.',
          'A charge that a wallet cannot cover is refused; work that already ran is not undone, and the uncharged record stays visible.',
        ],
        limits: [
          'Wallets are per owner and per workspace; a workspace wallet never draws on a member’s personal wallet automatically.',
          'Credits are moved between wallets only by an operator, with a reason.',
          'Negative balances require an explicit policy with a floor.',
        ],
      };
    },
  };
}
