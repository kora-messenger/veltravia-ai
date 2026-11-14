/**
 * The in-memory account action store (Step 62).
 *
 * The audit trail is append-only here for the same reason it is in PostgreSQL:
 * there is no method to change or delete a record. Approvals are consumable
 * exactly once, and `consumeApproval` reads and writes in one synchronous step so
 * two confirmations of the same ticket cannot both succeed.
 */

import { randomUUID } from 'node:crypto';

import type {
  AccountActionStore,
  AccountApproval,
  AccountAuditEntry,
  AccountAuditQuery,
} from './types.js';

export class InMemoryAccountActionStore implements AccountActionStore {
  private readonly entries: AccountAuditEntry[] = [];
  private readonly approvals = new Map<string, AccountApproval>();

  constructor(private readonly newId: () => string = () => `act_${randomUUID()}`) {}

  async record(entry: AccountAuditEntry): Promise<AccountAuditEntry> {
    const existing = this.entries.find(
      (candidate) =>
        candidate.ownerRef === entry.ownerRef && candidate.idempotencyKey === entry.idempotencyKey,
    );
    if (existing !== undefined) return existing;
    const stored: AccountAuditEntry = { ...entry, id: entry.id === '' ? this.newId() : entry.id };
    this.entries.push(stored);
    return stored;
  }

  async list(query: AccountAuditQuery): Promise<readonly AccountAuditEntry[]> {
    const rows = this.entries.filter((entry) => {
      if (entry.ownerRef !== query.ownerRef) return false;
      if (query.workspaceId != null && entry.workspaceId !== query.workspaceId) return false;
      if (query.tool != null && entry.tool !== query.tool) return false;
      if (query.status != null && entry.status !== query.status) return false;
      return true;
    });
    rows.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    const limit = Math.min(query.limit ?? 50, 100);
    return rows.slice(0, limit);
  }

  async get(entryId: string): Promise<AccountAuditEntry | null> {
    return this.entries.find((entry) => entry.id === entryId) ?? null;
  }

  async byIdempotencyKey(
    ownerRef: string,
    key: string,
  ): Promise<{ readonly entry: AccountAuditEntry } | null> {
    const entry = this.entries.find(
      (candidate) => candidate.ownerRef === ownerRef && candidate.idempotencyKey === key,
    );
    return entry === undefined ? null : { entry };
  }

  async saveApproval(approval: AccountApproval): Promise<AccountApproval> {
    this.approvals.set(approval.id, approval);
    return approval;
  }

  async getApproval(approvalId: string): Promise<AccountApproval | null> {
    return this.approvals.get(approvalId) ?? null;
  }

  async consumeApproval(approvalId: string, consumedAt: string): Promise<boolean> {
    const approval = this.approvals.get(approvalId);
    if (approval === undefined) return false;
    if (approval.state !== 'pending') return false;
    // Synchronous from the read to the write: one winner, no await in between.
    this.approvals.set(approvalId, {
      ...approval,
      state: 'consumed',
      consumedAt,
    });
    return true;
  }

  /** Test helper: count of rows, kept out of the port on purpose. */
  size(): number {
    return this.entries.length;
  }
}
