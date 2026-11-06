import { randomBytes } from 'node:crypto';

import { archiveBaseName, buildArchive, contentHashOf } from './archive.js';
import { validateArchive, type ArchiveValidation } from './validate.js';
import { readConsistently } from './consistency.js';
import { ExportError } from './errors.js';
import {
  assertSafeExportPath,
  isCredentialFileName,
  isWithin,
  normaliseSelection,
} from './paths.js';
import type { ArchiveStore, ExportSourcePort } from './ports.js';
import { scanForSecrets } from './secrets.js';
import { InMemoryArchiveStore } from './store.js';
import {
  EXPORT_LIMITS,
  type ExcludedFile,
  type ExportScope,
  type ExportView,
  type IncludedFile,
} from './types.js';

/**
 * One export's durable record: the view the API returns plus the two facts the
 * archive needs in order to be served again after a restart.
 */
export interface ExportRecordSeed {
  readonly view: ExportView;
  readonly ownerRef: string;
  readonly fileName: string | null;
}

/**
 * Where export records are kept outside the process.
 *
 * The bytes go through `ArchiveStore`; this is the job itself - status,
 * checksum, included and excluded files, expiry - which must outlive the
 * process so a finished export can still be listed and downloaded. Writes are
 * queued by the implementation, so a sink may return before the row is written;
 * `flush()` on that side is what makes a response mean "durable".
 */
export interface ExportRecordSink {
  save(seed: ExportRecordSeed): void | Promise<void>;
  delete(exportId: string): void | Promise<void>;
}

export interface ExportManagerOptions {
  readonly source: ExportSourcePort;
  readonly store?: ArchiveStore;
  readonly sink?: ExportRecordSink;
  readonly now?: () => Date;
}

export interface ExportRequest {
  readonly projectId: unknown;
  readonly scope?: unknown;
  readonly paths?: unknown;
}

interface ExportRecord {
  view: ExportView;
  readonly ownerRef: string;
  readonly fileName: string | null;
}

/**
 * Owner-scoped native export.
 *
 * Every public method takes the owner first and answers "not found" for an
 * export or project that is missing OR belongs to someone else, so ids cannot
 * be probed. Archive bytes leave only through `download`, which re-checks the
 * owner. Nothing here writes to the project.
 */
export class ExportManager {
  private readonly source: ExportSourcePort;
  private readonly store: ArchiveStore;
  private readonly now: () => Date;
  private readonly records = new Map<string, ExportRecord>();
  private readonly sink: ExportRecordSink | null;

  constructor(options: ExportManagerOptions) {
    this.source = options.source;
    this.store = options.store ?? new InMemoryArchiveStore();
    this.sink = options.sink ?? null;
    this.now = options.now ?? (() => new Date());
  }

  // -- create ---------------------------------------------------------------

  async createExport(ownerRef: string, request: ExportRequest): Promise<ExportView> {
    this.sweep();
    const projectId = parseProjectId(request.projectId);
    const scope = parseScope(request.scope);
    const selection =
      scope === 'selection' ? normaliseSelection(parseArray(request.paths)) : ([] as string[]);

    const project = await this.source.resolveProject({ ownerRef, projectId });
    if (project === null) {
      throw new ExportError('EXPORT_NOT_FOUND', 'That project was not found.');
    }

    const exportId = `exp_${randomBytes(18).toString('base64url')}`;
    const createdAt = this.now().toISOString();
    const base: ExportView = {
      exportId,
      projectId: project.projectId,
      workspaceId: project.workspaceId,
      scope,
      selection,
      status: 'running',
      revision: null,
      fileName: null,
      archiveBytes: null,
      archiveHash: null,
      included: [],
      excluded: [],
      totals: { files: 0, bytes: 0 },
      consistencyRetries: 0,
      failure: null,
      createdAt,
      expiresAt: null,
    };
    const record: ExportRecord = { view: base, ownerRef, fileName: null };
    this.records.set(exportId, record);
    if (this.sink !== null) {
      // Awaited: when a durable sink is configured, the caller must not see a
      // finished export that the store has not been told about.
      await this.sink.save({
        view: record.view,
        ownerRef: record.ownerRef,
        fileName: record.fileName,
      });
    }

    try {
      record.view = await this.run(record, project, scope, selection);
    } catch (error) {
      const failure =
        error instanceof ExportError
          ? { code: error.code, message: error.message }
          : {
              code: 'EXPORT_INTERNAL' as const,
              // The raw error is never shown: it could carry a path or content.
              message: 'The export could not be completed.',
            };
      record.view = {
        ...record.view,
        status: 'failed',
        failure,
        excluded: error instanceof ExportError ? error.excluded : [],
      };
    }
    return record.view;
  }

  private async run(
    record: ExportRecord,
    project: { projectId: string; workspaceId: string; name: string },
    scope: ExportScope,
    selection: readonly string[],
  ): Promise<ExportView> {
    const wanted =
      scope === 'project'
        ? () => true
        : (node: { path: string }) => selection.some((path) => isWithin(node.path, path));

    let retries = 0;
    let read = await readConsistently(this.source, project.workspaceId, wanted);
    while (read.changed) {
      if (retries + 1 >= EXPORT_LIMITS.maxConsistencyAttempts) {
        throw new ExportError(
          'EXPORT_REVISION_CONFLICT',
          'The project kept changing while it was being exported. Nothing was exported; try again when editing has paused.',
        );
      }
      retries += 1;
      read = await readConsistently(this.source, project.workspaceId, wanted);
    }
    if (read.changed)
      throw new ExportError('EXPORT_INTERNAL', 'The export could not be completed.');

    if (scope === 'selection') {
      const present = new Set([...read.files.map((f) => f.path), ...read.directories]);
      const missing = selection.filter(
        (path) => !present.has(path) && ![...present].some((p) => isWithin(p, path)),
      );
      if (missing.length > 0) {
        throw new ExportError('EXPORT_NOTHING_TO_EXPORT', 'A selected path does not exist.');
      }
    }

    // -- classify every file ------------------------------------------------
    const included: { path: string; content: string }[] = [];
    const excluded: ExcludedFile[] = [];
    let totalBytes = 0;

    for (const path of read.unreadable) {
      excluded.push({
        path,
        reason: 'unreadable',
        detail: 'This file could not be read in full, so it was left out.',
      });
    }

    for (const file of [...read.files].sort((a, b) => a.path.localeCompare(b.path))) {
      if (isCredentialFileName(file.path)) {
        excluded.push({
          path: file.path,
          reason: 'credential-file',
          detail: 'The file name marks it as holding credentials.',
        });
        continue;
      }
      const size = Buffer.byteLength(file.content, 'utf8');
      if (size > EXPORT_LIMITS.maxFileBytes) {
        excluded.push({
          path: file.path,
          reason: 'too-large',
          detail: 'The file is larger than a single export file may be.',
        });
        continue;
      }
      const finding = scanForSecrets(file.content);
      if (finding !== null) {
        excluded.push({
          path: file.path,
          reason: 'secret-in-content',
          detail: `The content looks like it contains a credential (${finding.kind}). It was not read further or included.`,
        });
        continue;
      }
      if (included.length >= EXPORT_LIMITS.maxFiles) {
        excluded.push({
          path: file.path,
          reason: 'file-count-limit',
          detail: 'The archive reached its file limit before this file.',
        });
        continue;
      }
      if (totalBytes + size > EXPORT_LIMITS.maxTotalBytes) {
        excluded.push({
          path: file.path,
          reason: 'total-size-limit',
          detail: 'The archive reached its size limit before this file.',
        });
        continue;
      }
      totalBytes += size;
      included.push({ path: file.path, content: file.content });
    }

    if (included.length === 0) {
      throw new ExportError(
        'EXPORT_NOTHING_TO_EXPORT',
        excluded.length > 0
          ? 'Every file was excluded, so there is nothing to export. See the excluded list.'
          : 'There are no files to export.',
        excluded,
      );
    }

    const baseName = archiveBaseName(project.name);
    const built = buildArchive(included, baseName);
    if (built.bytes.byteLength > EXPORT_LIMITS.maxArchiveBytes) {
      throw new ExportError('EXPORT_TOO_LARGE', 'The finished archive is larger than the limit.');
    }

    const expiresAtMs = this.now().getTime() + EXPORT_LIMITS.archiveTtlMs;
    this.enforcePerOwnerLimit(record.ownerRef);
    this.store.put({
      exportId: record.view.exportId,
      ownerRef: record.ownerRef,
      projectId: project.projectId,
      bytes: built.bytes,
      expiresAt: expiresAtMs,
    });

    const includedViews: IncludedFile[] = included.map((file) => ({
      path: file.path,
      size: Buffer.byteLength(file.content, 'utf8'),
      contentHash: contentHashOf(file.content),
    }));
    return {
      ...record.view,
      status: 'ready',
      revision: read.workspaceRevision,
      fileName: `${baseName}.zip`,
      archiveBytes: built.bytes.byteLength,
      archiveHash: built.sha256,
      included: includedViews,
      excluded,
      totals: { files: included.length, bytes: totalBytes },
      consistencyRetries: retries,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  // -- read -----------------------------------------------------------------

  status(ownerRef: string, exportId: string): ExportView {
    this.sweep();
    const record = this.ownedRecord(ownerRef, exportId);
    return this.currentView(record);
  }

  list(ownerRef: string, projectId?: string): readonly ExportView[] {
    this.sweep();
    return [...this.records.values()]
      .filter((record) => record.ownerRef === ownerRef)
      .filter((record) => projectId === undefined || record.view.projectId === projectId)
      .map((record) => this.currentView(record))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * The archive bytes, for the owner who made the export, while it is ready.
   * A foreign or unknown id answers exactly like a missing one.
   */
  download(
    ownerRef: string,
    exportId: string,
  ): { readonly bytes: Uint8Array; readonly fileName: string; readonly sha256: string } {
    this.sweep();
    const record = this.ownedRecord(ownerRef, exportId);
    const view = this.currentView(record);
    if (view.status === 'expired') {
      throw new ExportError('EXPORT_EXPIRED', 'This export has expired. Run it again.');
    }
    if (view.status !== 'ready' || view.fileName === null || view.archiveHash === null) {
      throw new ExportError('EXPORT_NOT_READY', 'This export has no archive to download.');
    }
    const stored = this.store.get(exportId);
    if (stored === undefined || stored.ownerRef !== ownerRef) {
      throw new ExportError('EXPORT_NOT_FOUND', 'That export was not found.');
    }
    return { bytes: stored.bytes, fileName: view.fileName, sha256: view.archiveHash };
  }

  /**
   * Seeds records read back from a durable store.
   *
   * Used at startup and per request by a deployment that keeps export records
   * outside the process: an export created before a restart can be listed and
   * downloaded again, and an id already held here is left alone so a live
   * record is never replaced by a stale one.
   */
  hydrate(seeds: readonly ExportRecordSeed[]): number {
    let added = 0;
    for (const seed of seeds) {
      if (this.records.has(seed.view.exportId)) continue;
      this.records.set(seed.view.exportId, {
        view: seed.view,
        ownerRef: seed.ownerRef,
        fileName: seed.fileName,
      });
      added += 1;
    }
    return added;
  }

  /** Re-open the stored archive and check it against the export's own record. */
  validate(ownerRef: string, exportId: string): ArchiveValidation & { readonly exportId: string } {
    this.sweep();
    const record = this.ownedRecord(ownerRef, exportId);
    const view = this.currentView(record);
    if (view.status === 'expired') {
      throw new ExportError('EXPORT_EXPIRED', 'This export has expired. Run it again.');
    }
    const stored = this.store.get(exportId);
    if (view.status !== 'ready' || stored === undefined || view.fileName === null) {
      throw new ExportError('EXPORT_NOT_READY', 'This export has no archive to validate.');
    }
    const root = view.fileName.replace(/\.zip$/, '');
    return { exportId, ...validateArchive(stored.bytes, root, view.included) };
  }

  /** Discard an export and its archive now. */
  discard(ownerRef: string, exportId: string): void {
    this.ownedRecord(ownerRef, exportId);
    this.store.delete(exportId);
    this.records.delete(exportId);
    void this.sink?.delete(exportId);
  }

  // -- housekeeping ---------------------------------------------------------

  /** Drop expired archives and mark their records expired. */
  sweep(): void {
    const nowMs = this.now().getTime();
    for (const record of this.records.values()) {
      const stored = this.store.get(record.view.exportId);
      if (stored !== undefined && stored.expiresAt <= nowMs) {
        this.store.delete(record.view.exportId);
      }
    }
  }

  private enforcePerOwnerLimit(ownerRef: string): void {
    const ids = this.store.idsFor(ownerRef);
    const surplus = ids.length - (EXPORT_LIMITS.maxArchivesPerOwner - 1);
    for (const id of ids.slice(0, Math.max(0, surplus))) {
      this.store.delete(id);
    }
  }

  private ownedRecord(ownerRef: string, exportId: string): ExportRecord {
    const record = this.records.get(exportId);
    // Same answer for "no such export" and "somebody else's".
    if (record === undefined || record.ownerRef !== ownerRef) {
      throw new ExportError('EXPORT_NOT_FOUND', 'That export was not found.');
    }
    return record;
  }

  private currentView(record: ExportRecord): ExportView {
    const view = record.view;
    if (view.status === 'ready' && this.store.get(view.exportId) === undefined) {
      return { ...view, status: 'expired' };
    }
    return view;
  }
}

// -- request parsing --------------------------------------------------------

function parseProjectId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new ExportError('EXPORT_INVALID_REQUEST', 'projectId must be a non-empty string.');
  }
  // Ids are opaque tokens, never paths.
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ExportError('EXPORT_INVALID_REQUEST', 'projectId is not a valid project id.');
  }
  return value;
}

function parseScope(value: unknown): ExportScope {
  if (value === undefined || value === 'project') return 'project';
  if (value === 'selection') return 'selection';
  throw new ExportError('EXPORT_INVALID_REQUEST', 'scope must be "project" or "selection".');
}

function parseArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ExportError('EXPORT_INVALID_REQUEST', 'paths must be an array of paths.');
  }
  return value;
}

export { assertSafeExportPath };
