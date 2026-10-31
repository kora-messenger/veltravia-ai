import { randomUUID } from 'node:crypto';

import type { UsageRecord } from '../types/index.js';

/**
 * Usage metadata store (Step 26).
 *
 * What is recorded: owner, optional project, provider, model, timestamp,
 * status, token counts the provider actually reported, latency and a normalized
 * error category.
 *
 * What is never recorded: prompts, completions, API keys, authorization
 * headers, provider response bodies. Token counts and costs are never invented -
 * they are null unless the provider reported them, and cost stays null because
 * no pricing is declared.
 */
export interface UsageStore {
  record(entry: UsageRecord): Promise<void>;
  listByOwner(ownerRef: string, limit?: number): Promise<readonly UsageRecord[]>;
}

export interface UsageLimits {
  readonly maxRecordsPerOwner: number;
}

export class InMemoryUsageStore implements UsageStore {
  private readonly records: UsageRecord[] = [];
  private readonly limits: UsageLimits;

  constructor(limits: UsageLimits = { maxRecordsPerOwner: 500 }) {
    this.limits = limits;
  }

  async record(entry: UsageRecord): Promise<void> {
    this.records.push(entry);
    const owned = this.records.filter((record) => record.ownerRef === entry.ownerRef);
    if (owned.length > this.limits.maxRecordsPerOwner) {
      const excess = owned.slice(0, owned.length - this.limits.maxRecordsPerOwner);
      for (const stale of excess) {
        const index = this.records.indexOf(stale);
        if (index >= 0) this.records.splice(index, 1);
      }
    }
  }

  async listByOwner(ownerRef: string, limit = 50): Promise<readonly UsageRecord[]> {
    return this.records
      .filter((record) => record.ownerRef === ownerRef)
      .slice(-limit)
      .reverse();
  }

  /** Test helper: proves no prompt or key material is stored. */
  snapshot(): readonly UsageRecord[] {
    return [...this.records];
  }
}

export function newUsageRecordId(): string {
  return `use_${randomUUID()}`;
}
