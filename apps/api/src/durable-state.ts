/**
 * Durable state for managers whose ports are synchronous.
 *
 * Version control and memory were easy: their store interfaces are already
 * asynchronous, so PostgreSQL sits directly underneath them. The sync manager
 * and the export manager read their state through SYNCHRONOUS ports
 * (`SyncStore`, `ArchiveStore`), because their public API has synchronous
 * methods (`status`, `history`, `download`) that routes call directly.
 *
 * Rather than turn those interfaces - and every caller and test with them -
 * inside out, this file keeps a per-owner mirror of the database rows and
 * writes through:
 *
 *  - `prepare(owner)` loads that owner's rows once per process. Reads then hit
 *    the mirror synchronously, exactly as they did in memory.
 *  - Every mutation updates the mirror and queues a database write.
 *  - `flush()` waits for the queue. The server calls it before a response is
 *    sent, so "the request succeeded" still means "it is in PostgreSQL".
 *
 * The mirror is scoped by the request owner and by nothing else; a row for
 * another owner is never loaded. That makes this single-instance by design:
 * two API processes do not share a warm mirror, which is stated in the docs.
 */

import type {
  ArchiveStore,
  ExportRecordSeed,
  ExportView,
  StoredArchive,
} from '@veltravia/export-core';
import type {
  Conflict,
  ConflictBodies,
  PlanRecord,
  SyncConnection,
  SyncHistoryEntry,
  SyncStore,
} from '@veltravia/sync-core';
import type {
  LocalObjectStore,
  PostgresExportJobStore,
  PostgresRunRecordStore,
  PostgresSyncStore,
  RunRecord,
} from '@veltravia/storage-postgres';

/** What a run record needs from a run view. Every manager's view has these. */
export interface RunViewLike {
  readonly id?: unknown;
  readonly runId?: unknown;
  readonly projectId?: unknown;
  readonly status?: unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

interface ArchiveMeta {
  readonly exportId: string;
  readonly ownerRef: string;
  readonly projectId: string;
  readonly expiresAt: number;
  readonly key: string;
}

interface OwnerState {
  readonly connections: Map<string, SyncConnection>;
  readonly bases: Map<string, Map<string, string>>;
  readonly plans: Map<string, PlanRecord>;
  readonly history: Map<string, SyncHistoryEntry[]>;
  readonly archives: Map<string, ArchiveMeta>;
}

function emptyOwner(): OwnerState {
  return {
    connections: new Map(),
    bases: new Map(),
    plans: new Map(),
    history: new Map(),
    archives: new Map(),
  };
}

/**
 * A plan survives a restart, so its Maps have to as well.
 *
 * `jsonb` cannot hold a Map, so the four maps are written as entry arrays and
 * rebuilt on read. This is the whole codec; there is no second representation.
 */
interface EncodedPlan {
  readonly ownerRef: string;
  readonly plan: unknown;
  readonly conflicts: readonly Conflict[];
  readonly bodies: readonly (readonly [string, ConflictBodies])[];
  readonly pushContent: readonly (readonly [string, string | null])[];
  readonly manual: readonly (readonly [string, string])[];
  readonly cancelled: boolean;
}

function encodePlan(record: PlanRecord): EncodedPlan {
  return {
    ownerRef: record.ownerRef,
    plan: record.plan,
    conflicts: [...record.conflicts],
    bodies: [...record.bodies.entries()],
    pushContent: [...record.pushContent.entries()],
    manual: [...record.manual.entries()],
    cancelled: record.cancelled,
  };
}

function decodePlan(payload: Record<string, unknown>): PlanRecord | null {
  const encoded = payload as unknown as EncodedPlan;
  if (encoded === null || typeof encoded !== 'object' || encoded.plan === undefined) return null;
  if (encoded.ownerRef === undefined) return null;
  return {
    ownerRef: encoded.ownerRef,
    plan: encoded.plan as PlanRecord['plan'],
    conflicts: [...(encoded.conflicts ?? [])],
    bodies: new Map(encoded.bodies ?? []),
    pushContent: new Map(encoded.pushContent ?? []),
    manual: new Map(encoded.manual ?? []),
    cancelled: encoded.cancelled === true,
  };
}

/** The object key for one export's archive. Stable, so a restart finds it. */
export function durableArchiveKey(projectId: string, exportId: string): string {
  return `exports/${projectId}/${exportId}.zip`;
}

export interface DurableStateOptions {
  readonly sync: PostgresSyncStore;
  readonly exports: PostgresExportJobStore;
  readonly runs: PostgresRunRecordStore;
  /** Where archive bytes live. Absent means bytes are not durable. */
  readonly objects?: LocalObjectStore | null;
  readonly now?: () => Date;
  /** Called when a write fails after a response. Never throws into a request. */
  readonly onWriteError?: (error: unknown) => void;
}

export class DurableState {
  private readonly syncRepo: PostgresSyncStore;
  private readonly exportRepo: PostgresExportJobStore;
  private readonly runRepo: PostgresRunRecordStore;
  private readonly objects: LocalObjectStore | null;
  private readonly now: () => Date;
  private readonly onWriteError: (error: unknown) => void;

  private readonly owners = new Map<string, OwnerState>();
  private readonly bytes = new Map<string, Uint8Array>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private firstError: unknown = null;

  readonly syncStore: SyncStore;
  readonly archiveStore: ArchiveStore;

  constructor(options: DurableStateOptions) {
    this.syncRepo = options.sync;
    this.exportRepo = options.exports;
    this.runRepo = options.runs;
    this.objects = options.objects ?? null;
    this.now = options.now ?? (() => new Date());
    this.onWriteError = options.onWriteError ?? (() => undefined);
    this.syncStore = this.buildSyncStore();
    this.archiveStore = this.buildArchiveStore();
  }

  /** True once a queued write has failed; the server reports the degraded state. */
  get writeFailure(): unknown {
    return this.firstError;
  }

  /** Queued writes not yet on disk. Exposed for the readiness/status surface. */
  get pendingWrites(): number {
    return this.pending;
  }

  private state(ownerRef: string): OwnerState {
    const existing = this.owners.get(ownerRef);
    if (existing !== undefined) return existing;
    const created = emptyOwner();
    this.owners.set(ownerRef, created);
    return created;
  }

  private enqueue(task: () => Promise<unknown>): void {
    this.pending += 1;
    this.queue = this.queue.then(task).then(
      () => {
        this.pending -= 1;
      },
      (error: unknown) => {
        this.pending -= 1;
        if (this.firstError === null) this.firstError = error;
        this.onWriteError(error);
      },
    );
  }

  /**
   * Waits for every queued write.
   *
   * A failure is reported once and then cleared, so one broken write does not
   * fail every later request; the caller decides what to do with it.
   */
  async flush(): Promise<void> {
    await this.queue;
    const error = this.firstError;
    if (error === null) return;
    this.firstError = null;
    throw error;
  }

  /**
   * Loads one owner's durable rows into the mirror.
   *
   * Called at the start of a request, inside the owner's scope, so the queries
   * are scoped by the request rather than by anything the caller sent.
   */
  async prepare(ownerRef: string): Promise<readonly ExportRecordSeed[]> {
    if (this.owners.has(ownerRef)) return [];
    const state = this.state(ownerRef);

    const sync = await this.syncRepo.loadOwner();
    for (const row of sync.connections) {
      const connection = row.payload.connection as SyncConnection | undefined;
      if (connection === undefined || connection === null) continue;
      state.connections.set(row.projectId, connection);
      const base = row.payload.base as readonly (readonly [string, string])[] | undefined;
      if (Array.isArray(base)) state.bases.set(row.projectId, new Map(base));
    }
    for (const row of sync.plans) {
      const record = decodePlan(row.payload);
      if (record !== null) state.plans.set(row.id, record);
    }
    for (const row of sync.history) {
      const entry = row.payload.entry as SyncHistoryEntry | undefined;
      if (entry === undefined) continue;
      const list = state.history.get(row.projectId) ?? [];
      list.push(entry);
      state.history.set(row.projectId, list);
    }

    const jobs = await this.exportRepo.listByOwner();
    const seeds: ExportRecordSeed[] = [];
    for (const job of jobs) {
      const view = job.body.view as ExportView | undefined;
      if (view === undefined) continue;
      const fileName = (job.body.fileName as string | null | undefined) ?? null;
      seeds.push({ view, ownerRef: job.ownerRef, fileName });
      if (view.status === 'ready' && job.expiresAt !== null) {
        state.archives.set(job.id, {
          exportId: job.id,
          ownerRef: job.ownerRef,
          projectId: job.projectId,
          expiresAt: new Date(job.expiresAt).getTime(),
          key: durableArchiveKey(job.projectId, job.id),
        });
      }
    }
    return seeds;
  }

  // -- sync port ------------------------------------------------------------

  private buildSyncStore(): SyncStore {
    const state = (owner: string) => this.state(owner);
    return {
      getConnection: (ownerRef, projectId) => state(ownerRef).connections.get(projectId),
      putConnection: (ownerRef, connection) => {
        const owner = state(ownerRef);
        owner.connections.set(connection.projectId, connection);
        const base = owner.bases.get(connection.projectId);
        this.enqueue(() =>
          this.syncRepo.saveConnection(connection.projectId, {
            connection,
            base: base === undefined ? [] : [...base.entries()],
          }),
        );
      },
      deleteConnection: (ownerRef, projectId) => {
        const owner = state(ownerRef);
        owner.connections.delete(projectId);
        owner.bases.delete(projectId);
        this.enqueue(() => this.syncRepo.deleteConnection(projectId));
      },
      getBase: (ownerRef, projectId) => state(ownerRef).bases.get(projectId),
      putBase: (ownerRef, projectId, base) => {
        const owner = state(ownerRef);
        owner.bases.set(projectId, new Map(base));
        const connection = owner.connections.get(projectId);
        this.enqueue(() =>
          this.syncRepo.saveConnection(projectId, {
            connection: connection ?? null,
            base: [...base.entries()],
          }),
        );
      },
      deleteBase: (ownerRef, projectId) => {
        const owner = state(ownerRef);
        owner.bases.delete(projectId);
        const connection = owner.connections.get(projectId);
        this.enqueue(() =>
          this.syncRepo.saveConnection(projectId, {
            connection: connection ?? null,
            base: [],
          }),
        );
      },
      getPlan: (planId) => {
        for (const owner of this.owners.values()) {
          const record = owner.plans.get(planId);
          if (record !== undefined) return record;
        }
        return undefined;
      },
      putPlan: (record) => {
        const owner = state(record.ownerRef);
        owner.plans.set(record.plan.planId, record);
        this.enqueue(() =>
          this.syncRepo.savePlan({
            id: record.plan.planId,
            projectId: record.plan.projectId,
            payload: encodePlan(record) as unknown as Record<string, unknown>,
            createdAt: record.plan.createdAt,
            expiresAt: record.plan.expiresAt,
          }),
        );
      },
      deletePlan: (planId) => {
        for (const owner of this.owners.values()) owner.plans.delete(planId);
        this.enqueue(() => this.syncRepo.deletePlan(planId));
      },
      plansFor: (ownerRef, projectId) =>
        [...state(ownerRef).plans.values()].filter((record) => record.plan.projectId === projectId),
      addHistory: (ownerRef, entry) => {
        const owner = state(ownerRef);
        const list = owner.history.get(entry.projectId) ?? [];
        list.push(entry);
        owner.history.set(entry.projectId, list);
        this.enqueue(() =>
          this.syncRepo.appendHistory({
            id: entry.entryId,
            projectId: entry.projectId,
            status: entry.outcome,
            payload: { entry } as unknown as Record<string, unknown>,
            createdAt: entry.at,
          }),
        );
      },
      history: (ownerRef, projectId) => state(ownerRef).history.get(projectId) ?? [],
    };
  }

  // -- archive (bytes) port -------------------------------------------------

  private buildArchiveStore(): ArchiveStore {
    return {
      put: (entry: StoredArchive) => {
        const key = durableArchiveKey(entry.projectId, entry.exportId);
        for (const [ownerRef, state] of this.owners) {
          if (ownerRef !== entry.ownerRef) continue;
          state.archives.set(entry.exportId, {
            exportId: entry.exportId,
            ownerRef: entry.ownerRef,
            projectId: entry.projectId,
            expiresAt: entry.expiresAt,
            key,
          });
        }
        // The bytes stay in this process for an immediate download; the disk
        // copy is what makes them survive a restart.
        this.bytes.set(entry.exportId, entry.bytes);
        if (this.objects === null) return;
        const objects = this.objects;
        this.enqueue(() =>
          objects.put({
            key,
            bytes: entry.bytes,
            contentType: 'application/zip',
            expiresAt: new Date(entry.expiresAt).toISOString(),
          }),
        );
      },
      get: (exportId) => {
        const owner = this.findArchive(exportId);
        if (owner === null) return undefined;
        const cached = this.bytes.get(exportId);
        const bytes = cached ?? this.readArchive(owner);
        if (bytes === null) return undefined;
        return {
          exportId,
          ownerRef: owner.ownerRef,
          projectId: owner.projectId,
          bytes,
          expiresAt: owner.expiresAt,
        };
      },
      delete: (exportId) => {
        const owner = this.findArchive(exportId);
        this.bytes.delete(exportId);
        for (const state of this.owners.values()) state.archives.delete(exportId);
        if (owner === null || this.objects === null) return;
        const objects = this.objects;
        this.enqueue(() => objects.delete(owner.key));
      },
      idsFor: (ownerRef) => {
        const state = this.owners.get(ownerRef);
        if (state === undefined) return [];
        return [...state.archives.values()]
          .filter((archive) => archive.ownerRef === ownerRef)
          .sort((a, b) => a.expiresAt - b.expiresAt)
          .map((archive) => archive.exportId);
      },
      size: () => {
        let total = 0;
        for (const state of this.owners.values()) total += state.archives.size;
        return total;
      },
    };
  }

  private findArchive(exportId: string): ArchiveMeta | null {
    for (const state of this.owners.values()) {
      const archive = state.archives.get(exportId);
      if (archive !== undefined) return archive;
    }
    return null;
  }

  private readArchive(owner: ArchiveMeta): Uint8Array | null {
    if (this.objects === null) return null;
    return this.objects.readSync(owner.key);
  }

  /**
   * Answers "how is this archive stored" for the API's honest status surface.
   * `local-filesystem` means a restart keeps it; `none` means it does not.
   */
  get archiveStorage(): 'local-filesystem' | 'none' {
    return this.objects === null ? 'none' : 'local-filesystem';
  }

  // -- run records ----------------------------------------------------------

  /**
   * Records a run view. Best-effort and queued: a run must never fail because
   * its audit copy could not be written, and `flush()` still waits for it.
   */
  rememberRun(kind: string, view: RunViewLike): void {
    const id = typeof view.id === 'string' ? view.id : view.runId;
    if (typeof id !== 'string') return;
    const at = this.now().toISOString();
    const createdAt = typeof view.createdAt === 'string' ? view.createdAt : at;
    const updatedAt = typeof view.updatedAt === 'string' ? view.updatedAt : at;
    const projectId = typeof view.projectId === 'string' ? view.projectId : null;
    const status = typeof view.status === 'string' ? view.status : 'unknown';
    this.enqueue(() =>
      this.runRepo.save({ kind, id, projectId, status, createdAt, updatedAt, body: { view } }),
    );
  }

  /** One stored run, owner-scoped by the repository. Null when absent. */
  async storedRun(kind: string, runId: string): Promise<RunRecord | null> {
    return this.runRepo.get(kind, runId);
  }

  async storedRuns(
    kind: string,
    query: { projectId?: string; status?: string; limit?: number } = {},
  ): Promise<RunRecord[]> {
    return this.runRepo.list(kind, query);
  }

  /** Writes one export record. Queued; `flush()` covers it. */
  saveExportRecord(seed: ExportRecordSeed): void {
    const view = seed.view;
    const expiresAt = view.expiresAt ?? null;
    this.enqueue(() =>
      this.exportRepo.save({
        id: view.exportId,
        projectId: view.projectId,
        status: view.status,
        createdAt: view.createdAt,
        updatedAt: this.now().toISOString(),
        expiresAt,
        body: { view, fileName: seed.fileName },
      }),
    );
  }

  /** Removes one export record and its archive metadata. */
  deleteExportRecord(exportId: string): void {
    this.enqueue(() => this.exportRepo.deleteJob(exportId));
  }

  /**
   * Sweeps expired export jobs and stored objects for the current owner.
   * Returns what was removed so the caller can report it honestly.
   */
  async sweepExpired(): Promise<{ jobs: number; objects: number }> {
    const jobs = await this.exportRepo.deleteExpired(this.now());
    const objects = this.objects === null ? 0 : await this.objects.sweep(this.now());
    return { jobs, objects };
  }
}

/**
 * Records the run views a manager returns.
 *
 * A manager keeps its live runs in memory, because a run is a state machine
 * with an in-flight model call and a sandbox behind it: it cannot be resumed in
 * another process. What CAN outlive the process is the record of what the run
 * did, which is what the API already hands back - so every returned view that
 * looks like a run (an id and a status) is written to `run_records`.
 *
 * Deliberately narrow: only returned values are inspected, nothing is altered,
 * and a failed write is queued rather than thrown, because an audit copy must
 * never break the run it describes.
 */
export function withRunRecording<T extends object>(
  manager: T,
  kind: string,
  durable: DurableState,
): T {
  const record = (value: unknown, depth = 0): void => {
    if (depth > 2 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) record(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    const candidate = value as Record<string, unknown>;
    const id = candidate.id ?? candidate.runId;
    if (typeof id === 'string' && typeof candidate.status === 'string') {
      durable.rememberRun(kind, candidate);
    }
    for (const nested of ['run', 'view']) {
      if (candidate[nested] !== undefined) record(candidate[nested], depth + 1);
    }
  };

  return new Proxy(manager, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (result instanceof Promise) {
          return result.then((resolved: unknown) => {
            record(resolved);
            return resolved;
          });
        }
        record(result);
        return result;
      };
    },
  });
}
