/**
 * In-memory stores for tests and for a deployment with no database configured.
 *
 * The claim method performs the limit check and the insert in one synchronous
 * step, which is atomic because JavaScript runs one thing at a time. The
 * PostgreSQL store does the same thing with one conditional statement. Neither
 * is allowed to check and then insert as two steps.
 */

import {
  USAGE_LIMITS,
  type UsageAdjustment,
  type UsageCategory,
  type UsageRecord,
  type UsageReservation,
} from './types.js';
import type { UsageStore } from './ledger.js';

export class InMemoryUsageStore implements UsageStore {
  private records: UsageRecord[] = [];
  private reservations: UsageReservation[] = [];
  private adjustments: UsageAdjustment[] = [];
  private readonly limit: number;
  private readonly clock: () => Date;

  constructor(limit = USAGE_LIMITS.maxRecordsPerOwner, clock: () => Date = () => new Date()) {
    this.limit = limit;
    this.clock = clock;
  }

  async insertRecord(record: UsageRecord): Promise<boolean> {
    if (
      this.records.some(
        (row) => row.ownerRef === record.ownerRef && row.operationKey === record.operationKey,
      )
    ) {
      return false;
    }
    this.records.push(record);
    const owned = this.records.filter((row) => row.ownerRef === record.ownerRef);
    if (owned.length > this.limit) {
      const excess = new Set(owned.slice(0, owned.length - this.limit).map((row) => row.id));
      this.records = this.records.filter((row) => !excess.has(row.id));
    }
    return true;
  }

  async findRecord(operationKey: string): Promise<UsageRecord | null> {
    return this.records.find((row) => row.operationKey === operationKey) ?? null;
  }

  async listRecords(filter: {
    projectId?: string | null;
    category?: UsageCategory;
    from?: string;
    to?: string;
    limit: number;
    offset?: number;
  }): Promise<readonly UsageRecord[]> {
    const rows = this.records
      .filter((row) => (filter.projectId === undefined ? true : row.projectId === filter.projectId))
      .filter((row) => (filter.category === undefined ? true : row.category === filter.category))
      .filter((row) => (filter.from === undefined ? true : row.occurredAt >= filter.from))
      .filter((row) => (filter.to === undefined ? true : row.occurredAt < filter.to))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    const offset = filter.offset ?? 0;
    return rows.slice(offset, offset + filter.limit);
  }

  async insertAdjustment(adjustment: UsageAdjustment): Promise<boolean> {
    if (this.adjustments.some((row) => row.auditId === adjustment.auditId)) return false;
    this.adjustments.push(adjustment);
    return true;
  }

  async listAdjustments(filter: {
    projectId?: string | null;
    from?: string;
    to?: string;
    limit: number;
  }): Promise<readonly UsageAdjustment[]> {
    return this.adjustments
      .filter((row) => (filter.projectId === undefined ? true : row.projectId === filter.projectId))
      .filter((row) => (filter.from === undefined ? true : row.recordedAt >= filter.from))
      .filter((row) => (filter.to === undefined ? true : row.recordedAt < filter.to))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, filter.limit);
  }

  async claimReservation(input: {
    reservation: UsageReservation;
    limitKey: import('./types.js').QuotaLimitKey | null;
    limit: number | null;
    now: string;
  }): Promise<UsageReservation | null> {
    const existing = this.reservations.find(
      (row) => row.operationKey === input.reservation.operationKey,
    );
    if (existing !== undefined) return existing;
    if (input.limit !== null) {
      const live = this.reservations
        .filter(
          (row) =>
            row.ownerRef === input.reservation.ownerRef &&
            row.category === input.reservation.category &&
            row.status === 'held' &&
            row.expiresAt > input.now,
        )
        .reduce((sum, row) => sum + row.quantity, 0);
      if (live + input.reservation.quantity > input.limit) return null;
    }
    this.reservations.push(input.reservation);
    return input.reservation;
  }

  async settleReservation(input: {
    operationKey: string;
    status: Exclude<UsageReservation['status'], 'held'>;
    now: string;
    note?: string | null;
  }): Promise<UsageReservation | null> {
    const index = this.reservations.findIndex((row) => row.operationKey === input.operationKey);
    if (index < 0) return null;
    const found = this.reservations[index] as UsageReservation;
    const settled: UsageReservation = {
      ...found,
      status: input.status,
      settledAt: input.now,
      note: input.note === undefined ? found.note : input.note,
    };
    this.reservations[index] = settled;
    return settled;
  }

  async listReservations(filter: {
    projectId?: string | null;
    status?: UsageReservation['status'];
    now?: string;
    limit: number;
  }): Promise<readonly UsageReservation[]> {
    return this.reservations
      .filter((row) => (filter.projectId === undefined ? true : row.projectId === filter.projectId))
      .filter((row) => (filter.status === undefined ? true : row.status === filter.status))
      .slice(0, filter.limit);
  }

  async countLiveReservations(category: UsageCategory): Promise<number> {
    const now = this.clock().toISOString();
    return this.reservations.filter(
      (row) => row.category === category && row.status === 'held' && row.expiresAt > now,
    ).length;
  }
}
