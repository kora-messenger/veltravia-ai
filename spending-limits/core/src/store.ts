/**
 * Where limits are kept (Step 59).
 *
 * Four things are stored, and they are deliberately four:
 *
 *  - the **policy** per scope, which is configuration and is replaced whole;
 *  - the **platform policy**, one row, which only narrows;
 *  - the **events**: warnings, refusals and policy changes as they happened.
 *    Their dedupe key is unique per owner, so a threshold that has fired cannot
 *    fire again for the same window even if fifty requests cross it at once;
 *  - the **audit**: who changed which limit, from what to what, and why.
 *
 * Usage is read from the existing charge lanes, never from here. A second place
 * that remembers spending is a second place that can be wrong.
 */

import type {
  LimitAuditRecord,
  LimitEvent,
  LimitScope,
  PlatformLimitPolicy,
  SpendingLimitPolicy,
} from './types.js';

export interface PolicyKey {
  readonly ownerRef: string;
  readonly scope: LimitScope;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
}

export interface SavePolicyResult {
  readonly policy: SpendingLimitPolicy;
  readonly created: boolean;
}

export interface EventFilter {
  readonly kind?: LimitEvent['kind'];
  readonly since?: string;
  readonly limit: number;
}

export interface AuditFilter {
  readonly limit: number;
  readonly since?: string;
}

export interface SpendingLimitStore {
  readonly kind: 'memory' | 'postgres';

  readPolicy(key: PolicyKey): Promise<SpendingLimitPolicy | null>;
  /** Every policy one owner has set, newest write first. Never another owner's. */
  listPolicies(ownerRef: string): Promise<readonly SpendingLimitPolicy[]>;
  /**
   * Writes the policy if the caller holds the current version. `expectedVersion`
   * is `null` for a create. Returns `null` when the row moved on.
   */
  savePolicy(
    policy: SpendingLimitPolicy,
    expectedVersion: number | null,
  ): Promise<SpendingLimitPolicy | null>;
  deletePolicy(key: PolicyKey, expectedVersion: number): Promise<boolean>;

  readPlatform(): Promise<PlatformLimitPolicy | null>;
  savePlatform(policy: PlatformLimitPolicy): Promise<PlatformLimitPolicy>;

  /** Appends an event once per dedupe key; a repeat returns the first row. */
  appendEvent(event: LimitEvent): Promise<{ event: LimitEvent; created: boolean }>;
  listEvents(ownerRef: string, filter: EventFilter): Promise<readonly LimitEvent[]>;

  appendAudit(record: LimitAuditRecord): Promise<LimitAuditRecord>;
  listAudit(ownerRef: string, filter: AuditFilter): Promise<readonly LimitAuditRecord[]>;
}
