/**
 * The in-memory store (Step 59).
 *
 * Same contract as the Postgres store, including the parts that matter under
 * concurrency: the version check on a policy write and the unique dedupe key on
 * an event are decided here, not by the caller. A test double that silently
 * accepted a stale write would let a race pass in a unit test and fail in
 * production, which is the wrong way round.
 */

import type {
  AuditFilter,
  EventFilter,
  PolicyKey,
  SavePolicyResult,
  SpendingLimitStore,
} from './store.js';
import type {
  LimitAuditRecord,
  LimitEvent,
  PlatformLimitPolicy,
  SpendingLimitPolicy,
} from './types.js';

const keyOf = (key: PolicyKey): string =>
  `${key.ownerRef}\u0000${key.scope}\u0000${key.workspaceId ?? ''}\u0000${key.projectId ?? ''}`;

export class InMemorySpendingLimitStore implements SpendingLimitStore {
  readonly kind = 'memory' as const;

  private readonly policies = new Map<string, SpendingLimitPolicy>();
  private readonly events: LimitEvent[] = [];
  private readonly audit: LimitAuditRecord[] = [];
  private readonly eventKeys = new Set<string>();
  private platform: PlatformLimitPolicy | null = null;

  async readPolicy(key: PolicyKey): Promise<SpendingLimitPolicy | null> {
    return this.policies.get(keyOf(key)) ?? null;
  }

  async listPolicies(ownerRef: string): Promise<readonly SpendingLimitPolicy[]> {
    return [...this.policies.values()]
      .filter((policy) => policy.ownerRef === ownerRef)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async savePolicy(
    policy: SpendingLimitPolicy,
    expectedVersion: number | null,
  ): Promise<SpendingLimitPolicy | null> {
    const key = keyOf(policy);
    const existing = this.policies.get(key) ?? null;
    if (expectedVersion === null) {
      if (existing !== null) return null;
    } else if (existing === null || existing.version !== expectedVersion) {
      return null;
    }
    this.policies.set(key, policy);
    return policy;
  }

  async deletePolicy(key: PolicyKey, expectedVersion: number): Promise<boolean> {
    const existing = this.policies.get(keyOf(key));
    if (existing === undefined || existing.version !== expectedVersion) return false;
    this.policies.delete(keyOf(key));
    return true;
  }

  async readPlatform(): Promise<PlatformLimitPolicy | null> {
    return this.platform;
  }

  async savePlatform(policy: PlatformLimitPolicy): Promise<PlatformLimitPolicy> {
    this.platform = policy;
    return policy;
  }

  async appendEvent(event: LimitEvent): Promise<{ event: LimitEvent; created: boolean }> {
    const key = `${event.ownerRef}\u0000${event.dedupeKey}`;
    if (this.eventKeys.has(key)) {
      const first = this.events.find(
        (row) => row.ownerRef === event.ownerRef && row.dedupeKey === event.dedupeKey,
      );
      return { event: first ?? event, created: false };
    }
    this.eventKeys.add(key);
    this.events.push(event);
    return { event, created: true };
  }

  async listEvents(ownerRef: string, filter: EventFilter): Promise<readonly LimitEvent[]> {
    return this.events
      .filter((event) => event.ownerRef === ownerRef)
      .filter((event) => filter.kind === undefined || event.kind === filter.kind)
      .filter(
        (event) =>
          filter.since === undefined || Date.parse(event.occurredAt) >= Date.parse(filter.since),
      )
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, filter.limit);
  }

  async appendAudit(record: LimitAuditRecord): Promise<LimitAuditRecord> {
    this.audit.push(record);
    return record;
  }

  async listAudit(ownerRef: string, filter: AuditFilter): Promise<readonly LimitAuditRecord[]> {
    return this.audit
      .filter((record) => record.ownerRef === ownerRef)
      .filter(
        (record) =>
          filter.since === undefined || Date.parse(record.occurredAt) >= Date.parse(filter.since),
      )
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
      .slice(0, filter.limit);
  }
}

export type { SavePolicyResult };
