/**
 * In-memory wallet store, for tests and for a deployment with no database.
 *
 * `apply` performs the balance check and the write in one synchronous step,
 * which is atomic because JavaScript runs one thing at a time: two concurrent
 * deductions cannot both read the balance before either writes it. The
 * PostgreSQL store gets the same guarantee from one conditional update inside a
 * transaction. Neither is allowed to check and then write as two steps.
 */

import {
  WalletError,
  round4,
  type Wallet,
  type WalletEntry,
  type WalletEntryKind,
  type WalletReservation,
  type WalletScope,
} from './types.js';
import { computeBalances, type ApplyResult, type EntryDraft, type WalletStore } from './ledger.js';

export class InMemoryWalletStore implements WalletStore {
  private wallets: Wallet[] = [];
  private entries: WalletEntry[] = [];
  private reservations: WalletReservation[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 100_000) {
    this.maxEntries = maxEntries;
  }

  async getWallet(input: {
    ownerRef: string;
    scope: WalletScope;
    workspaceId: string | null;
  }): Promise<Wallet | null> {
    return (
      this.wallets.find(
        (wallet) =>
          wallet.ownerRef === input.ownerRef &&
          wallet.scope === input.scope &&
          (wallet.workspaceId ?? null) === (input.workspaceId ?? null),
      ) ?? null
    );
  }

  async createWallet(wallet: Wallet): Promise<Wallet> {
    const existing = await this.getWallet(wallet);
    if (existing !== null) return existing;
    this.wallets = [...this.wallets, wallet];
    return wallet;
  }

  async listWallets(ownerRef: string): Promise<readonly Wallet[]> {
    return this.wallets.filter((wallet) => wallet.ownerRef === ownerRef);
  }

  /*
   * Deliberately synchronous from the duplicate check to the write. Every `await`
   * above that write is a place another request can read the same balance and
   * apply against it, which is exactly how ten deductions from one hundred
   * credits all succeed. The async port methods wrap these; they are not called
   * from inside here.
   */
  async apply(input: { wallet: Wallet; draft: EntryDraft }): Promise<ApplyResult> {
    return this.applySync(input.wallet, input.draft);
  }

  private applySync(walletRef: Wallet, draft: EntryDraft): ApplyResult {
    const duplicate = this.entryByKey(walletRef.ownerRef, draft.idempotencyKey);
    if (duplicate !== null) {
      return { created: false, entry: duplicate, wallet: this.walletFor(walletRef) ?? walletRef };
    }
    if (this.entries.length >= this.maxEntries) {
      throw new WalletError(
        'LIMIT_EXCEEDED',
        `This store holds at most ${this.maxEntries} ledger entries.`,
        503,
      );
    }
    const current = this.walletFor(walletRef);
    if (current === null) {
      throw new WalletError(
        'NOT_FOUND',
        'The wallet disappeared before the entry was applied.',
        404,
      );
    }
    if (current.version !== walletRef.version) {
      // The caller's view is stale; retry on the fresh wallet rather than write
      // a delta computed against a balance that no longer exists.
      throw new WalletError(
        'INVALID_STATE',
        'The wallet changed while this entry was being prepared. Retry against the current balance.',
        409,
        { expectedVersion: walletRef.version, actualVersion: current.version },
      );
    }
    const next = computeBalances(current, draft);
    const seq = this.entries.filter((row) => row.ownerRef === current.ownerRef).length + 1;
    const entry: WalletEntry = {
      ...draft,
      walletId: current.id,
      ownerRef: current.ownerRef,
      scope: current.scope,
      workspaceId: current.workspaceId,
      seq,
      balanceAfter: next.available,
      reservedAfter: next.reserved,
      spentAfter: next.spent,
    };
    const wallet: Wallet = {
      ...current,
      ...next,
      version: current.version + 1,
      updatedAt: entry.occurredAt,
    };
    this.wallets = this.wallets.map((row) => (row.id === wallet.id ? wallet : row));
    this.entries = [...this.entries, entry];
    return { created: true, entry, wallet };
  }

  private entryByKey(ownerRef: string, idempotencyKey: string): WalletEntry | null {
    return (
      this.entries.find(
        (row) => row.ownerRef === ownerRef && row.idempotencyKey === idempotencyKey,
      ) ?? null
    );
  }

  private walletFor(ref: {
    ownerRef: string;
    scope: WalletScope;
    workspaceId: string | null;
  }): Wallet | null {
    return (
      this.wallets.find(
        (wallet) =>
          wallet.ownerRef === ref.ownerRef &&
          wallet.scope === ref.scope &&
          (wallet.workspaceId ?? null) === (ref.workspaceId ?? null),
      ) ?? null
    );
  }

  async findEntryByKey(ownerRef: string, idempotencyKey: string): Promise<WalletEntry | null> {
    return this.entryByKey(ownerRef, idempotencyKey);
  }

  async findEntry(ownerRef: string, entryId: string): Promise<WalletEntry | null> {
    return this.entries.find((row) => row.ownerRef === ownerRef && row.id === entryId) ?? null;
  }

  async listEntries(
    ownerRef: string,
    filter: {
      walletId?: string | null;
      kinds?: readonly WalletEntryKind[];
      limit: number;
      beforeSeq?: number;
    },
  ): Promise<readonly WalletEntry[]> {
    return this.entries
      .filter((row) => row.ownerRef === ownerRef)
      .filter((row) => !filter.walletId || row.walletId === filter.walletId)
      .filter((row) => !filter.kinds || filter.kinds.includes(row.kind))
      .filter((row) => filter.beforeSeq === undefined || row.seq < filter.beforeSeq)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, filter.limit);
  }

  async countEntries(ownerRef: string): Promise<number> {
    return this.entries.filter((row) => row.ownerRef === ownerRef).length;
  }

  async insertReservation(reservation: WalletReservation): Promise<{
    created: boolean;
    reservation: WalletReservation;
  }> {
    const existing = this.reservations.find(
      (row) =>
        row.ownerRef === reservation.ownerRef && row.operationKey === reservation.operationKey,
    );
    if (existing !== undefined) return { created: false, reservation: existing };
    this.reservations = [...this.reservations, reservation];
    return { created: true, reservation };
  }

  async findReservation(
    ownerRef: string,
    by: { id?: string; operationKey?: string },
  ): Promise<WalletReservation | null> {
    return (
      this.reservations.find(
        (row) =>
          row.ownerRef === ownerRef &&
          (by.id === undefined || row.id === by.id) &&
          (by.operationKey === undefined || row.operationKey === by.operationKey),
      ) ?? null
    );
  }

  async listReservations(
    ownerRef: string,
    filter: { walletId?: string | null; state?: WalletReservation['state']; limit: number },
  ): Promise<readonly WalletReservation[]> {
    return this.reservations
      .filter((row) => row.ownerRef === ownerRef)
      .filter((row) => !filter.walletId || row.walletId === filter.walletId)
      .filter((row) => !filter.state || row.state === filter.state)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, filter.limit);
  }

  async settleReservation(input: {
    ownerRef: string;
    reservationId: string;
    state: 'committed' | 'released' | 'expired';
    committedAmount: number | null;
    settledAt: string;
  }): Promise<boolean> {
    const row = this.reservations.find(
      (entry) => entry.ownerRef === input.ownerRef && entry.id === input.reservationId,
    );
    if (row === undefined || row.state !== 'held') return false;
    this.reservations = this.reservations.map((entry) =>
      entry.id === row.id
        ? {
            ...entry,
            state: input.state,
            committedAmount: input.committedAmount === null ? null : round4(input.committedAmount),
            settledAt: input.settledAt,
          }
        : entry,
    );
    return true;
  }

  async updatePolicy(wallet: Wallet): Promise<Wallet> {
    const current = this.walletFor(wallet);
    if (current === null) {
      throw new WalletError('NOT_FOUND', 'No wallet exists to change the policy on.', 404);
    }
    const next: Wallet = {
      ...current,
      policy: wallet.policy,
      version: current.version + 1,
      updatedAt: wallet.updatedAt,
    };
    this.wallets = this.wallets.map((row) => (row.id === next.id ? next : row));
    return next;
  }

  async refundedTotal(ownerRef: string, entryId: string): Promise<number> {
    return round4(
      this.entries
        .filter(
          (row) =>
            row.ownerRef === ownerRef && row.kind === 'refund' && row.referenceId === entryId,
        )
        .reduce((total, row) => total + row.amount, 0),
    );
  }

  async findReversal(ownerRef: string, entryId: string): Promise<WalletEntry | null> {
    return (
      this.entries.find(
        (row) =>
          row.ownerRef === ownerRef && row.kind === 'reversal' && row.reversesEntryId === entryId,
      ) ?? null
    );
  }
}
