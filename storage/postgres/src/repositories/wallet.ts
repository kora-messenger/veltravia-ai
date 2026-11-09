/**
 * Wallet, ledger and holds in PostgreSQL (Step 53).
 *
 * The guarantee lives in `apply`, and it is one sentence: the balance is read
 * `for update` inside the same transaction that writes the entry, so a second
 * deduction waits for the first to commit and then computes against the balance
 * that actually exists. Checking a balance in one statement and inserting in
 * another is precisely how two deductions each get the last credit; that cannot
 * happen here because there is no moment between the two.
 *
 * The unique `(owner_ref, idempotency_key)` on `wallet_entries` is the second
 * half of it: a retried request does not race, it simply finds its own row and
 * returns it, which is why a duplicate can never be charged twice even if the
 * caller retries after a timeout whose write actually landed.
 *
 * Nothing in this store updates or deletes an entry. A correction is a new row.
 */

import { computeBalances, round4 } from '@veltravia/wallet-core';
import type {
  Wallet,
  WalletEntry,
  WalletEntryKind,
  WalletReservation,
  WalletScope,
  WalletStore,
} from '@veltravia/wallet-core';

import { requireOwner } from '../owner-scope.js';
import type { Queryable } from '../pool.js';
import type { ApplyResult, EntryDraft } from '@veltravia/wallet-core';

const num = (value: number | string | null): number => {
  if (value === null) return 0;
  return typeof value === 'number' ? value : Number(value);
};

interface WalletRow {
  id: string;
  owner_ref: string;
  scope: WalletScope;
  workspace_id: string | null;
  unit: Wallet['unit'];
  available: string;
  reserved: string;
  spent: string;
  allow_negative: boolean;
  negative_floor: string;
  version: string | number;
  created_at: Date;
  updated_at: Date;
}

interface EntryRow {
  seq: string | number;
  id: string;
  owner_ref: string;
  wallet_id: string;
  scope: WalletScope;
  workspace_id: string | null;
  kind: WalletEntryKind;
  amount: string;
  unit: WalletEntry['unit'];
  available_delta: string;
  reserved_delta: string;
  spent_delta: string;
  balance_after: string;
  reserved_after: string;
  spent_after: string;
  source: WalletEntry['source'];
  actor: string;
  reason: string;
  reference_type: string | null;
  reference_id: string | null;
  idempotency_key: string;
  reverses_entry_id: string | null;
  occurred_at: Date;
}

interface ReservationRow {
  id: string;
  owner_ref: string;
  wallet_id: string;
  amount: string;
  unit: WalletReservation['unit'];
  state: WalletReservation['state'];
  operation_key: string;
  reference_type: string | null;
  reference_id: string | null;
  committed_amount: string | null;
  expires_at: Date;
  settled_at: Date | null;
  created_at: Date;
}

const WALLET_COLUMNS = `id, owner_ref, scope, workspace_id, unit, available, reserved, spent,
  allow_negative, negative_floor, version, created_at, updated_at`;

const ENTRY_COLUMNS = `seq, id, owner_ref, wallet_id, scope, workspace_id, kind, amount, unit,
  available_delta, reserved_delta, spent_delta, balance_after, reserved_after, spent_after,
  source, actor, reason, reference_type, reference_id, idempotency_key, reverses_entry_id,
  occurred_at`;

const RESERVATION_COLUMNS = `id, owner_ref, wallet_id, amount, unit, state, operation_key,
  reference_type, reference_id, committed_amount, expires_at, settled_at, created_at`;

const toWallet = (row: WalletRow): Wallet => ({
  id: row.id,
  ownerRef: row.owner_ref,
  scope: row.scope,
  workspaceId: row.workspace_id,
  unit: row.unit,
  available: num(row.available),
  reserved: num(row.reserved),
  spent: num(row.spent),
  policy: { allowNegative: row.allow_negative, negativeFloor: num(row.negative_floor) },
  version: Number(row.version),
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});

const toEntry = (row: EntryRow): WalletEntry => ({
  seq: Number(row.seq),
  id: row.id,
  ownerRef: row.owner_ref,
  walletId: row.wallet_id,
  scope: row.scope,
  workspaceId: row.workspace_id,
  kind: row.kind,
  amount: num(row.amount),
  unit: row.unit,
  availableDelta: num(row.available_delta),
  reservedDelta: num(row.reserved_delta),
  spentDelta: num(row.spent_delta),
  balanceAfter: num(row.balance_after),
  reservedAfter: num(row.reserved_after),
  spentAfter: num(row.spent_after),
  source: row.source,
  actor: row.actor,
  reason: row.reason,
  referenceType: row.reference_type,
  referenceId: row.reference_id,
  idempotencyKey: row.idempotency_key,
  reversesEntryId: row.reverses_entry_id,
  occurredAt: new Date(row.occurred_at).toISOString(),
});

const toReservation = (row: ReservationRow): WalletReservation => ({
  id: row.id,
  ownerRef: row.owner_ref,
  walletId: row.wallet_id,
  amount: num(row.amount),
  unit: row.unit,
  state: row.state,
  operationKey: row.operation_key,
  referenceType: row.reference_type,
  referenceId: row.reference_id,
  committedAmount: row.committed_amount === null ? null : num(row.committed_amount),
  expiresAt: new Date(row.expires_at).toISOString(),
  createdAt: new Date(row.created_at).toISOString(),
  settledAt: row.settled_at === null ? null : new Date(row.settled_at).toISOString(),
});

export class PostgresWalletStore implements WalletStore {
  private readonly query: Queryable;

  constructor(query: Queryable) {
    this.query = query;
  }

  private async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const withTx = this.query as Queryable & {
      withTransaction?: <R>(fn: (tx: Queryable) => Promise<R>) => Promise<R>;
    };
    if (withTx.withTransaction === undefined) return work(this.query);
    return withTx.withTransaction(work);
  }

  async getWallet(input: {
    ownerRef: string;
    scope: WalletScope;
    workspaceId: string | null;
  }): Promise<Wallet | null> {
    const owner = requireOwner();
    const result = await this.query.query<WalletRow>(
      `select ${WALLET_COLUMNS} from wallets
        where owner_ref = $1 and scope = $2 and coalesce(workspace_id, '') = coalesce($3, '')`,
      [owner, input.scope, input.workspaceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toWallet(row);
  }

  async createWallet(wallet: Wallet): Promise<Wallet> {
    const owner = requireOwner();
    // The caller's bound owner and the wallet's owner are the same thing. If they
    // ever disagree, one of them is a bug and writing the row would file somebody
    // else's credits under the wrong account.
    if (wallet.ownerRef !== owner) {
      throw new Error('wallet owner does not match the bound owner');
    }
    await this.query.query(
      `insert into wallets (id, owner_ref, scope, workspace_id, unit, available, reserved, spent,
                            allow_negative, negative_floor, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict do nothing`,
      [
        wallet.id,
        owner,
        wallet.scope,
        wallet.workspaceId,
        wallet.unit,
        wallet.available,
        wallet.reserved,
        wallet.spent,
        wallet.policy.allowNegative,
        wallet.policy.negativeFloor,
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
    );
    // Whoever won the insert is the wallet; a concurrent create is not an error.
    const existing = await this.getWallet({
      ownerRef: wallet.ownerRef,
      scope: wallet.scope,
      workspaceId: wallet.workspaceId,
    });
    return existing ?? wallet;
  }

  async listWallets(_ownerRef: string): Promise<readonly Wallet[]> {
    const owner = requireOwner();
    const result = await this.query.query<WalletRow>(
      `select ${WALLET_COLUMNS} from wallets where owner_ref = $1 order by created_at`,
      [owner],
    );
    return result.rows.map(toWallet);
  }

  /**
   * The atomic step: lock the wallet, check the deltas against it, write the
   * entry, write the new balance. A duplicate key returns the entry that exists.
   */
  async apply(input: { wallet: Wallet; draft: EntryDraft }): Promise<ApplyResult> {
    const owner = requireOwner();
    return this.transaction(async (tx) => {
      // The wallet row is locked FIRST, before the duplicate check. Two
      // concurrent retries of the same request therefore queue: the second one
      // acquires the lock after the first commits and then sees the entry the
      // first wrote, instead of both deciding the key is free and one of them
      // failing on the unique index. The caller's `version` is not consulted:
      // the row we hold is the authority, which is stronger than the check it
      // could do on a balance it read outside the transaction.
      const locked = await tx.query<WalletRow>(
        `select ${WALLET_COLUMNS} from wallets where id = $1 and owner_ref = $2 for update`,
        [input.wallet.id, owner],
      );
      const row = locked.rows[0];
      if (row === undefined) {
        throw new WalletNotFound();
      }
      const duplicate = await tx.query<EntryRow>(
        `select ${ENTRY_COLUMNS} from wallet_entries where owner_ref = $1 and idempotency_key = $2`,
        [owner, input.draft.idempotencyKey],
      );
      const existing = duplicate.rows[0];
      if (existing !== undefined) {
        return { created: false, entry: toEntry(existing), wallet: toWallet(row) };
      }

      const current = toWallet(row);
      const next = computeBalances(current, input.draft);

      const inserted = await tx.query<EntryRow>(
        `insert into wallet_entries (${ENTRY_COLUMNS})
         values (default, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18, $19, $20, $21, $22)
         returning ${ENTRY_COLUMNS}`,
        [
          input.draft.id,
          owner,
          current.id,
          current.scope,
          current.workspaceId,
          input.draft.kind,
          input.draft.amount,
          input.draft.unit,
          input.draft.availableDelta,
          input.draft.reservedDelta,
          input.draft.spentDelta,
          next.available,
          next.reserved,
          next.spent,
          input.draft.source,
          input.draft.actor,
          input.draft.reason,
          input.draft.referenceType,
          input.draft.referenceId,
          input.draft.idempotencyKey,
          input.draft.reversesEntryId,
          input.draft.occurredAt,
        ],
      );

      const updated = await tx.query<WalletRow>(
        `update wallets
            set available = $3, reserved = $4, spent = $5, version = version + 1, updated_at = $6
          where id = $1 and owner_ref = $2
          returning ${WALLET_COLUMNS}`,
        [current.id, owner, next.available, next.reserved, next.spent, input.draft.occurredAt],
      );

      const entryRow = inserted.rows[0];
      if (entryRow === undefined) throw new WalletNotFound();
      return {
        created: true,
        entry: toEntry(entryRow),
        wallet: toWallet(updated.rows[0] ?? row),
      };
    });
  }

  async findEntryByKey(_ownerRef: string, idempotencyKey: string): Promise<WalletEntry | null> {
    const owner = requireOwner();
    const result = await this.query.query<EntryRow>(
      `select ${ENTRY_COLUMNS} from wallet_entries where owner_ref = $1 and idempotency_key = $2`,
      [owner, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEntry(row);
  }

  async findEntry(_ownerRef: string, entryId: string): Promise<WalletEntry | null> {
    const owner = requireOwner();
    const result = await this.query.query<EntryRow>(
      `select ${ENTRY_COLUMNS} from wallet_entries where owner_ref = $1 and id = $2`,
      [owner, entryId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEntry(row);
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
    const owner = requireOwner();
    const result = await this.query.query<EntryRow>(
      `select ${ENTRY_COLUMNS} from wallet_entries
        where owner_ref = $1
          and ($2::text is null or wallet_id = $2)
          and ($3::text[] is null or kind = any($3))
          and ($4::bigint is null or seq < $4)
        order by seq desc
        limit $5`,
      [
        owner,
        filter.walletId ?? null,
        filter.kinds === undefined ? null : [...filter.kinds],
        filter.beforeSeq ?? null,
        filter.limit,
      ],
    );
    return result.rows.map(toEntry);
  }

  async countEntries(_ownerRef: string): Promise<number> {
    const owner = requireOwner();
    const result = await this.query.query<{ total: string }>(
      `select count(*)::text as total from wallet_entries where owner_ref = $1`,
      [owner],
    );
    return Number(result.rows[0]?.total ?? '0');
  }

  async insertReservation(reservation: WalletReservation): Promise<{
    created: boolean;
    reservation: WalletReservation;
  }> {
    const owner = requireOwner();
    const inserted = await this.query.query<ReservationRow>(
      `insert into wallet_reservations (${RESERVATION_COLUMNS})
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (owner_ref, operation_key) do nothing
       returning ${RESERVATION_COLUMNS}`,
      [
        reservation.id,
        owner,
        reservation.walletId,
        reservation.amount,
        reservation.unit,
        reservation.state,
        reservation.operationKey,
        reservation.referenceType,
        reservation.referenceId,
        reservation.committedAmount,
        reservation.expiresAt,
        reservation.settledAt,
        reservation.createdAt,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return { created: true, reservation: toReservation(row) };
    const existing = await this.findReservation(owner, { operationKey: reservation.operationKey });
    return { created: false, reservation: existing ?? reservation };
  }

  async findReservation(
    ownerRef: string,
    by: { id?: string; operationKey?: string },
  ): Promise<WalletReservation | null> {
    const owner = requireOwner();
    const result = await this.query.query<ReservationRow>(
      `select ${RESERVATION_COLUMNS} from wallet_reservations
        where owner_ref = $1
          and ($2::text is null or id = $2)
          and ($3::text is null or operation_key = $3)
        limit 1`,
      [owner, by.id ?? null, by.operationKey ?? null],
    );
    const row = result.rows[0];
    return row === undefined ? null : toReservation(row);
  }

  async listReservations(
    ownerRef: string,
    filter: { walletId?: string | null; state?: WalletReservation['state']; limit: number },
  ): Promise<readonly WalletReservation[]> {
    const owner = requireOwner();
    const result = await this.query.query<ReservationRow>(
      `select ${RESERVATION_COLUMNS} from wallet_reservations
        where owner_ref = $1
          and ($2::text is null or wallet_id = $2)
          and ($3::text is null or state = $3)
        order by created_at desc
        limit $4`,
      [owner, filter.walletId ?? null, filter.state ?? null, filter.limit],
    );
    return result.rows.map(toReservation);
  }

  async settleReservation(input: {
    ownerRef: string;
    reservationId: string;
    state: 'committed' | 'released' | 'expired';
    committedAmount: number | null;
    settledAt: string;
  }): Promise<boolean> {
    const owner = requireOwner();
    // Compare-and-set on `state = 'held'`: the second settle of a hold changes
    // nothing and is told so, which is what makes a double release impossible.
    const result = await this.query.query<{ id: string }>(
      `update wallet_reservations
          set state = $3, committed_amount = $4, settled_at = $5
        where owner_ref = $1 and id = $2 and state = 'held'
        returning id`,
      [owner, input.reservationId, input.state, input.committedAmount, input.settledAt],
    );
    return result.rows.length > 0;
  }

  async updatePolicy(wallet: Wallet): Promise<Wallet> {
    const owner = requireOwner();
    const result = await this.query.query<WalletRow>(
      `update wallets
          set allow_negative = $3, negative_floor = $4, version = version + 1, updated_at = $5
        where owner_ref = $1 and id = $2
        returning ${WALLET_COLUMNS}`,
      [
        owner,
        wallet.id,
        wallet.policy.allowNegative,
        wallet.policy.negativeFloor,
        wallet.updatedAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new WalletNotFound();
    return toWallet(row);
  }

  async refundedTotal(ownerRef: string, entryId: string): Promise<number> {
    const owner = requireOwner();
    const result = await this.query.query<{ total: string | null }>(
      `select coalesce(sum(amount), 0)::text as total from wallet_entries
        where owner_ref = $1 and kind = 'refund' and reference_id = $2`,
      [owner, entryId],
    );
    return round4(Number(result.rows[0]?.total ?? '0'));
  }

  async findReversal(ownerRef: string, entryId: string): Promise<WalletEntry | null> {
    const owner = requireOwner();
    const result = await this.query.query<EntryRow>(
      `select ${ENTRY_COLUMNS} from wallet_entries
        where owner_ref = $1 and kind = 'reversal' and reverses_entry_id = $2
        limit 1`,
      [owner, entryId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEntry(row);
  }
}

/** The wallet row is gone: the caller's read is older than a deletion. */
export class WalletNotFound extends Error {
  readonly code = 'WALLET_NOT_FOUND';
  constructor() {
    super('The wallet no longer exists.');
    this.name = 'WalletNotFound';
  }
}
