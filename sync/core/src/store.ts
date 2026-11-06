import type { Conflict, SyncConnection, SyncHistoryEntry, SyncPlan } from './types.js';
import { SYNC_LIMITS } from './types.js';

/**
 * Where sync state lives. A port, so a database can replace the memory store.
 *
 * IN MEMORY TODAY: connections, plans, conflict bodies and history vanish when
 * the API restarts, exactly like the projects they describe. Nothing here
 * claims otherwise. A restart also forgets the "base" a later sync compares
 * against, so the first sync after a restart is treated as an initial sync and
 * is compared against whatever the remote holds; it cannot silently overwrite
 * it, because it cannot assume anything was agreed.
 */

/** Both versions of a conflicted file. Private: only the owner's explicit view call reads them. */
export interface ConflictBodies {
  readonly local: string | null;
  readonly remote: string | null;
}

export interface PlanRecord {
  readonly ownerRef: string;
  plan: SyncPlan;
  conflicts: Conflict[];
  /** Text of both sides per conflicted path, held until resolved. */
  readonly bodies: Map<string, ConflictBodies>;
  /** Content to publish and to pull, by path. Dropped once the plan finishes. */
  readonly pushContent: Map<string, string | null>;
  readonly manual: Map<string, string>;
  cancelled: boolean;
}

export interface SyncStore {
  getConnection(ownerRef: string, projectId: string): SyncConnection | undefined;
  putConnection(ownerRef: string, connection: SyncConnection): void;
  deleteConnection(ownerRef: string, projectId: string): void;

  /** What both sides agreed on last time: path -> hash. */
  getBase(ownerRef: string, projectId: string): ReadonlyMap<string, string> | undefined;
  putBase(ownerRef: string, projectId: string, base: ReadonlyMap<string, string>): void;
  deleteBase(ownerRef: string, projectId: string): void;

  getPlan(planId: string): PlanRecord | undefined;
  putPlan(record: PlanRecord): void;
  deletePlan(planId: string): void;
  plansFor(ownerRef: string, projectId: string): readonly PlanRecord[];

  addHistory(ownerRef: string, entry: SyncHistoryEntry): void;
  history(ownerRef: string, projectId: string): readonly SyncHistoryEntry[];
}

const key = (ownerRef: string, projectId: string): string => `${ownerRef}\u0000${projectId}`;

export class InMemorySyncStore implements SyncStore {
  private readonly connections = new Map<string, SyncConnection>();
  private readonly bases = new Map<string, ReadonlyMap<string, string>>();
  private readonly plans = new Map<string, PlanRecord>();
  private readonly entries = new Map<string, SyncHistoryEntry[]>();

  getConnection(ownerRef: string, projectId: string) {
    return this.connections.get(key(ownerRef, projectId));
  }
  putConnection(ownerRef: string, connection: SyncConnection) {
    this.connections.set(key(ownerRef, connection.projectId), connection);
  }
  deleteConnection(ownerRef: string, projectId: string) {
    this.connections.delete(key(ownerRef, projectId));
  }

  getBase(ownerRef: string, projectId: string) {
    return this.bases.get(key(ownerRef, projectId));
  }
  putBase(ownerRef: string, projectId: string, base: ReadonlyMap<string, string>) {
    this.bases.set(key(ownerRef, projectId), new Map(base));
  }
  deleteBase(ownerRef: string, projectId: string) {
    this.bases.delete(key(ownerRef, projectId));
  }

  getPlan(planId: string) {
    return this.plans.get(planId);
  }
  putPlan(record: PlanRecord) {
    this.plans.set(record.plan.planId, record);
  }
  deletePlan(planId: string) {
    this.plans.delete(planId);
  }
  plansFor(ownerRef: string, projectId: string) {
    return [...this.plans.values()].filter(
      (r) => r.ownerRef === ownerRef && r.plan.projectId === projectId,
    );
  }

  addHistory(ownerRef: string, entry: SyncHistoryEntry) {
    const k = key(ownerRef, entry.projectId);
    const list = [...(this.entries.get(k) ?? []), entry];
    this.entries.set(k, list.slice(-SYNC_LIMITS.maxHistoryEntries));
  }
  history(ownerRef: string, projectId: string) {
    return [...(this.entries.get(key(ownerRef, projectId)) ?? [])].reverse();
  }
}
