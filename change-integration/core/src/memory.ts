/**
 * In-memory implementations of every port.
 *
 * They are what runs when no database is configured, and they are the doubles
 * the tests use. The lock is honest about being process-local: another process
 * cannot see it, which is why the Postgres implementation exists.
 */

import type {
  ApprovalStore,
  ChangeArtifactPort,
  ChangeSetStatus,
  ChangeSetStore,
  IntegrationLockPort,
  IntegrationRecord,
  IntegrationStatus,
  IntegrationStore,
  IntegrationApproval,
  WorkerChangeSet,
} from './types.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class InMemoryChangeSetStore implements ChangeSetStore {
  private readonly byId = new Map<string, WorkerChangeSet>();

  private key(ownerRef: string, id: string): string {
    return `${ownerRef}::${id}`;
  }

  async insert(changeSet: WorkerChangeSet): Promise<void> {
    this.byId.set(this.key(changeSet.ownerRef, changeSet.id), clone(changeSet));
  }

  async update(changeSet: WorkerChangeSet): Promise<void> {
    this.byId.set(this.key(changeSet.ownerRef, changeSet.id), clone(changeSet));
  }

  async get(ownerRef: string, changeSetId: string): Promise<WorkerChangeSet | null> {
    const found = this.byId.get(this.key(ownerRef.trim(), changeSetId));
    return found === undefined ? null : clone(found);
  }

  async list(
    ownerRef: string,
    filter: {
      projectId?: string;
      taskId?: string;
      workerId?: string;
      status?: readonly ChangeSetStatus[];
      limit?: number;
    } = {},
  ): Promise<readonly WorkerChangeSet[]> {
    const owner = ownerRef.trim();
    const rows = Array.from(this.byId.values())
      .filter((row) => row.ownerRef === owner)
      .filter((row) => (filter.projectId === undefined ? true : row.projectId === filter.projectId))
      .filter((row) => (filter.taskId === undefined ? true : row.taskId === filter.taskId))
      .filter((row) => (filter.workerId === undefined ? true : row.workerId === filter.workerId))
      .filter((row) => (filter.status === undefined ? true : filter.status.includes(row.status)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 100);
    return rows.map(clone);
  }
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly rows: IntegrationApproval[] = [];

  async insert(approval: IntegrationApproval): Promise<void> {
    this.rows.push(clone(approval));
  }

  async get(ownerRef: string, approvalId: string): Promise<IntegrationApproval | null> {
    const found = this.rows.find(
      (row) => row.ownerRef === ownerRef.trim() && row.id === approvalId,
    );
    return found === undefined ? null : clone(found);
  }

  async list(ownerRef: string, projectId?: string): Promise<readonly IntegrationApproval[]> {
    return this.rows
      .filter((row) => row.ownerRef === ownerRef.trim())
      .filter((row) => (projectId === undefined ? true : row.projectId === projectId))
      .map(clone);
  }
}

export class InMemoryIntegrationStore implements IntegrationStore {
  private readonly byId = new Map<string, IntegrationRecord>();

  private key(ownerRef: string, id: string): string {
    return `${ownerRef}::${id}`;
  }

  async insert(record: IntegrationRecord): Promise<void> {
    this.byId.set(this.key(record.ownerRef, record.id), clone(record));
  }

  async update(record: IntegrationRecord): Promise<void> {
    this.byId.set(this.key(record.ownerRef, record.id), clone(record));
  }

  async get(ownerRef: string, integrationId: string): Promise<IntegrationRecord | null> {
    const found = this.byId.get(this.key(ownerRef.trim(), integrationId));
    return found === undefined ? null : clone(found);
  }

  async list(
    ownerRef: string,
    filter: { projectId?: string; status?: readonly IntegrationStatus[]; limit?: number } = {},
  ): Promise<readonly IntegrationRecord[]> {
    const owner = ownerRef.trim();
    return Array.from(this.byId.values())
      .filter((row) => row.ownerRef === owner)
      .filter((row) => (filter.projectId === undefined ? true : row.projectId === filter.projectId))
      .filter((row) => (filter.status === undefined ? true : filter.status.includes(row.status)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 100)
      .map(clone);
  }
}

export class InMemoryChangeArtifacts implements ChangeArtifactPort {
  private readonly blobs = new Map<string, string>();

  private key(changeSetId: string, path: string): string {
    return `${changeSetId}::${path}`;
  }

  async put(input: { changeSetId: string; path: string; content: string }): Promise<string> {
    const key = this.key(input.changeSetId, input.path);
    this.blobs.set(key, input.content);
    return key;
  }

  async get(input: { changeSetId: string; path: string }): Promise<string | null> {
    return this.blobs.get(this.key(input.changeSetId, input.path)) ?? null;
  }

  async delete(changeSetId: string): Promise<void> {
    for (const key of Array.from(this.blobs.keys())) {
      if (key.startsWith(`${changeSetId}::`)) this.blobs.delete(key);
    }
  }

  /** Test helper: how much content this store holds. */
  get size(): number {
    return this.blobs.size;
  }
}

/**
 * A process-local project lock.
 *
 * It stops two integrations inside one server from interleaving. It does not
 * stop a second server, and the Postgres implementation is what does that.
 */
export class InMemoryIntegrationLocks implements IntegrationLockPort {
  private readonly leases = new Map<string, { token: string; at: number; ttlMs: number }>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 60_000,
  ) {}

  async acquire(projectId: string, token: string): Promise<boolean> {
    const existing = this.leases.get(projectId);
    if (existing !== undefined && this.now() - existing.at < existing.ttlMs) return false;
    this.leases.set(projectId, { token, at: this.now(), ttlMs: this.ttlMs });
    return true;
  }

  async release(projectId: string, token: string): Promise<void> {
    const existing = this.leases.get(projectId);
    if (existing !== undefined && existing.token === token) this.leases.delete(projectId);
  }

  async held(projectId: string): Promise<string | null> {
    const existing = this.leases.get(projectId);
    if (existing === undefined) return null;
    if (this.now() - existing.at >= existing.ttlMs) {
      this.leases.delete(projectId);
      return null;
    }
    return existing.token;
  }
}
