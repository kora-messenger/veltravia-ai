/**
 * Owner-scoped native source repositories (Step 31).
 *
 * This is NOT a second project-management system. Projects and workspaces still
 * belong to the project engine; the source layer sits on top of it and adds
 * what the engine deliberately does not: a content-addressed snapshot store,
 * per-file history, atomic multi-file change sets, and a deterministic
 * manifest that optional GitHub sync can consume.
 *
 * Every write goes through `SourceTreePort`, which the API implements with the
 * SAME project engine the coding agent and app builder use. There is no second
 * place source code can live.
 */

import { containsSecretShapedContent } from '@veltravia/project-core';

import { SourceError } from '../errors/index.js';
import { FileHistory, type KnownPathState } from '../history/index.js';
import { compareManifests, type ManifestEntry } from '../snapshot/index.js';
import {
  buildManifest,
  byteLength,
  contentHashOf,
  InMemoryContentStore,
  type ContentStore,
} from '../store/index.js';
import {
  SOURCE_LIMITS,
  type ChangeOperation,
  type ChangeSetResult,
  type FileRevisionEntry,
  type SnapshotComparison,
  type SnapshotDetail,
  type SnapshotView,
  type SourceFileContent,
  type SourceFileView,
  type SourceManifest,
  type SourceTreeView,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** One node as the project engine reports it. */
export interface SourceTreeNode {
  readonly path: string;
  readonly type: 'file' | 'directory';
  readonly revision: number;
  readonly updatedAt?: string;
}

/**
 * The project engine boundary. Everything the source layer needs is here, and
 * nothing else: no host filesystem, no shell, no network.
 */
export interface SourceTreePort {
  listAll(workspaceId: string): Promise<readonly SourceTreeNode[]>;
  readFile(
    workspaceId: string,
    path: string,
  ): Promise<{ readonly revision: number; readonly content: string }>;
  createFile(
    workspaceId: string,
    path: string,
    content: string,
  ): Promise<{ readonly revision: number }>;
  updateFile(
    workspaceId: string,
    path: string,
    content: string,
    expectedRevision: number,
  ): Promise<{ readonly revision: number }>;
  deleteFile(workspaceId: string, path: string): Promise<void>;
  createDirectory(workspaceId: string, path: string): Promise<{ readonly revision: number }>;
  deleteDirectory(workspaceId: string, path: string): Promise<void>;
  moveNode(
    workspaceId: string,
    fromPath: string,
    toDirectory: string,
  ): Promise<{ readonly path: string; readonly revision: number }>;
  renameNode(
    workspaceId: string,
    path: string,
    newName: string,
  ): Promise<{ readonly path: string; readonly revision: number }>;
  rootRevision(workspaceId: string): Promise<number>;
}

/**
 * Ownership resolution. `resolveRepository` MUST return null when the project
 * does not exist OR belongs to somebody else, so the source layer cannot tell
 * the two apart and never leaks the existence of another owner's project.
 */
export interface SourceProjectsPort {
  resolveRepository(input: {
    readonly ownerRef: string;
    readonly projectId: string;
    readonly workspaceId?: string;
  }): Promise<{ readonly projectId: string; readonly workspaceId: string } | null>;
}

export interface SourceManagerOptions {
  readonly projects: SourceProjectsPort;
  readonly tree: SourceTreePort;
  readonly store?: ContentStore;
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

interface RepositoryState {
  readonly ownerRef: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly history: FileHistory;
  snapshots: SnapshotDetail[];
  /** True once the tree has been seen at least once (an empty tree counts). */
  initialized: boolean;
}

// ---------------------------------------------------------------------------
// Path and secret safety
// ---------------------------------------------------------------------------

const SECRET_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.netrc',
  'id_rsa',
  'id_ed25519',
]);

/** Reject anything that could escape the repository or confuse the engine. */
export function assertSafeSourcePath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new SourceError('SOURCE_PATH_INVALID', 'A path is required.');
  }
  if (rawPath.length > 512) {
    throw new SourceError('SOURCE_PATH_INVALID', 'That path is too long.', {
      length: rawPath.length,
    });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rawPath)) {
    throw new SourceError('SOURCE_PATH_INVALID', 'That path contains control characters.');
  }
  if (rawPath.includes('\\')) {
    throw new SourceError('SOURCE_PATH_INVALID', 'Use "/" to separate directories.');
  }
  if (rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath)) {
    throw new SourceError('SOURCE_PATH_INVALID', 'Paths are relative to the project root.');
  }
  if (rawPath.endsWith('/')) {
    throw new SourceError('SOURCE_PATH_INVALID', 'That path ends with a separator.');
  }
  const segments = rawPath.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new SourceError('SOURCE_PATH_INVALID', 'That path has an empty segment.');
    }
    if (segment === '.' || segment === '..') {
      throw new SourceError('SOURCE_PATH_INVALID', 'That path steps outside the project.');
    }
    if (segment.length > 255) {
      throw new SourceError('SOURCE_PATH_INVALID', 'One path segment is too long.');
    }
  }
  if (SECRET_FILE_NAMES.has(segments[segments.length - 1]!.toLowerCase())) {
    throw new SourceError(
      'SOURCE_SECRET_REJECTED',
      'That file name is reserved for credentials and cannot be stored in project source.',
    );
  }
  return rawPath;
}

/** Reject content that looks like a credential, in project source or not. */
export function assertNoSecretContent(path: string, content: string): void {
  if (containsSecretShapedContent(content)) {
    throw new SourceError(
      'SOURCE_SECRET_REJECTED',
      `"${path}" looks like it contains a credential.`,
      {
        path,
      },
    );
  }
}

function assertContentSize(path: string, content: string): number {
  const size = byteLength(content);
  if (size > SOURCE_LIMITS.maxFileBytes) {
    throw new SourceError(
      'SOURCE_FILE_TOO_LARGE',
      `"${path}" is larger than this release accepts.`,
      {
        path,
        size,
        limit: SOURCE_LIMITS.maxFileBytes,
      },
    );
  }
  return size;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class SourceRepositoryManager {
  private readonly projects: SourceProjectsPort;
  private readonly port: SourceTreePort;
  private readonly store: ContentStore;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly repositories = new Map<string, RepositoryState>();

  constructor(options: SourceManagerOptions) {
    this.projects = options.projects;
    this.port = options.tree;
    this.store = options.store ?? new InMemoryContentStore();
    this.now = options.now ?? (() => new Date());
    this.generateId =
      options.generateId ?? (() => `src_${Math.random().toString(36).slice(2, 12)}`);
  }

  // -- resolution ----------------------------------------------------------

  private async repository(
    ownerRef: string,
    projectId: string,
    workspaceId?: string,
  ): Promise<RepositoryState> {
    if (typeof ownerRef !== 'string' || ownerRef.length === 0) {
      throw new SourceError('SOURCE_INVALID_REQUEST', 'An owner is required.');
    }
    const resolved = await this.projects.resolveRepository({
      ownerRef,
      projectId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
    if (resolved === null) {
      // Deliberately identical for "missing" and "not yours".
      throw new SourceError(
        'SOURCE_REPOSITORY_NOT_FOUND',
        'That project repository does not exist.',
      );
    }
    const key = `${resolved.projectId}:${resolved.workspaceId}`;
    const existing = this.repositories.get(key);
    if (existing !== undefined) {
      if (existing.ownerRef !== ownerRef) {
        throw new SourceError(
          'SOURCE_REPOSITORY_NOT_FOUND',
          'That project repository does not exist.',
        );
      }
      return existing;
    }
    const state: RepositoryState = {
      ownerRef,
      projectId: resolved.projectId,
      workspaceId: resolved.workspaceId,
      history: new FileHistory(this.generateId, this.now),
      snapshots: [],
      initialized: false,
    };
    this.repositories.set(key, state);
    return state;
  }

  // -- observation ---------------------------------------------------------

  /**
   * Attribute changes made OUTSIDE the source API (coding agent, app builder,
   * sandbox) by diffing the engine's tree against what this layer last saw.
   *
   * The actor is recorded as `external-writer` because guessing a more specific
   * author would be fiction.
   */
  private async observe(state: RepositoryState): Promise<Map<string, KnownPathState>> {
    const nodes = await this.port.listAll(state.workspaceId);
    const known = state.history.knownState();
    const next = new Map<string, KnownPathState>();

    // First sight of a repository is a BASELINE, not a burst of "created"
    // events: files that were already there were not changed by anyone now.
    // An EMPTY tree also counts as seen - otherwise a file added later would be
    // absorbed into a second baseline and never reported.
    if (!state.initialized) {
      state.initialized = true;
      for (const node of nodes) {
        if (node.type === 'directory') {
          next.set(node.path, {
            revision: node.revision,
            size: 0,
            contentHash: null,
            type: 'directory',
          });
          continue;
        }
        const file = await this.port.readFile(state.workspaceId, node.path);
        next.set(node.path, {
          revision: node.revision,
          size: byteLength(file.content),
          contentHash: contentHashOf(file.content),
          type: 'file',
        });
      }
      state.history.remember(next);
      return next;
    }

    for (const node of nodes) {
      const previous = known.get(node.path);
      if (node.type === 'directory') {
        next.set(node.path, {
          revision: node.revision,
          size: 0,
          contentHash: null,
          type: 'directory',
        });
        continue;
      }
      if (
        previous !== undefined &&
        previous.type === 'file' &&
        previous.revision === node.revision
      ) {
        next.set(node.path, previous);
        continue;
      }
      const file = await this.port.readFile(state.workspaceId, node.path);
      const content = file.content.length > SOURCE_LIMITS.maxReadBytes ? '' : file.content;
      const size = content.length === 0 ? 0 : byteLength(content);
      const contentHash = content.length === 0 ? null : contentHashOf(content);
      next.set(node.path, { revision: node.revision, size, contentHash, type: 'file' });
      state.history.record({
        path: node.path,
        changeKind: previous === undefined ? 'created' : 'modified',
        revision: node.revision,
        size,
        contentHash,
        actor: 'external-writer',
        summary:
          previous === undefined
            ? 'File appeared in the workspace without going through the source API.'
            : 'File changed outside the source API.',
      });
    }

    for (const [path, previous] of known) {
      if (next.has(path)) continue;
      state.history.record({
        path,
        changeKind: 'deleted',
        revision: 0,
        size: previous.size,
        contentHash: null,
        actor: 'external-writer',
        summary: 'File was removed outside the source API.',
      });
    }

    state.history.remember(next);
    return next;
  }

  // -- reads ---------------------------------------------------------------

  async tree(
    ownerRef: string,
    input: { projectId: string; workspaceId?: string },
  ): Promise<SourceTreeView> {
    const state = await this.repository(ownerRef, input.projectId, input.workspaceId);
    await this.observe(state);
    const nodes = await this.port.listAll(state.workspaceId);
    const files: SourceFileView[] = [];
    const directories: string[] = [];
    let bytes = 0;

    for (const node of nodes) {
      if (node.type === 'directory') {
        directories.push(node.path);
        continue;
      }
      const remembered = state.history.knownState().get(node.path);
      const size = remembered?.size ?? 0;
      bytes += size;
      files.push({
        path: node.path,
        type: 'file',
        revision: node.revision,
        size,
        updatedAt: node.updatedAt ?? this.now().toISOString(),
        contentHash: remembered?.contentHash ?? null,
      });
    }

    return {
      projectId: state.projectId,
      workspaceId: state.workspaceId,
      rootRevision: await this.port.rootRevision(state.workspaceId),
      files,
      directories: directories.sort((left, right) => left.localeCompare(right)),
      totals: { files: files.length, bytes },
    };
  }

  async readFile(
    ownerRef: string,
    input: { projectId: string; workspaceId?: string; path: string },
  ): Promise<SourceFileContent> {
    const path = assertSafeSourcePath(input.path);
    const state = await this.repository(ownerRef, input.projectId, input.workspaceId);
    const file = await this.port.readFile(state.workspaceId, path);
    const size = byteLength(file.content);
    const truncated = size > SOURCE_LIMITS.maxReadBytes;
    const content = truncated ? file.content.slice(0, SOURCE_LIMITS.maxReadBytes) : file.content;
    return {
      path,
      revision: file.revision,
      size,
      contentHash: contentHashOf(file.content),
      content,
      truncated,
    };
  }

  async history(
    ownerRef: string,
    input: { projectId: string; workspaceId?: string; path?: string; limit?: number },
  ): Promise<{
    entries: readonly FileRevisionEntry[];
    summary: { changed: number; kinds: Record<string, number> };
  }> {
    const state = await this.repository(ownerRef, input.projectId, input.workspaceId);
    await this.observe(state);
    return {
      entries: state.history.list({
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
      summary: state.history.summary(),
    };
  }

  // -- writes --------------------------------------------------------------

  /**
   * Apply many file operations as one unit.
   *
   * Everything is checked BEFORE the first write. If a write fails anyway, the
   * operations already applied are compensated in reverse order, and the
   * caller is told exactly how many were undone. A rollback that itself fails
   * is reported as SOURCE_ROLLBACK_FAILED with both counts - never hidden.
   */
  async changeSet(
    ownerRef: string,
    input: {
      projectId: string;
      workspaceId?: string;
      operations: readonly ChangeOperation[];
      summary?: string;
    },
  ): Promise<ChangeSetResult> {
    if (!Array.isArray(input.operations) || input.operations.length === 0) {
      throw new SourceError('SOURCE_INVALID_REQUEST', 'A change set needs at least one operation.');
    }
    if (input.operations.length > SOURCE_LIMITS.maxChangeSetOperations) {
      throw new SourceError('SOURCE_LIMIT_EXCEEDED', 'That change set has too many operations.', {
        operations: input.operations.length,
        limit: SOURCE_LIMITS.maxChangeSetOperations,
      });
    }

    const state = await this.repository(ownerRef, input.projectId, input.workspaceId);
    await this.observe(state);

    // 0: validate every operation's shape and paths up front.
    const seenTargets = new Set<string>();
    for (const operation of input.operations) {
      const targets = this.pathsOf(operation);
      for (const target of targets) {
        assertSafeSourcePath(target);
        if (seenTargets.has(target)) {
          throw new SourceError(
            'SOURCE_INVALID_REQUEST',
            `"${target}" is changed twice in one change set.`,
            {
              path: target,
            },
          );
        }
        seenTargets.add(target);
      }
      if (operation.op === 'create' || operation.op === 'update') {
        assertContentSize(operation.path, operation.content);
        assertNoSecretContent(operation.path, operation.content);
      }
    }

    const nodes = await this.port.listAll(state.workspaceId);
    const files = new Map(
      nodes.filter((node) => node.type === 'file').map((node) => [node.path, node]),
    );
    if (files.size + input.operations.length > SOURCE_LIMITS.maxFilesPerRepository) {
      throw new SourceError('SOURCE_LIMIT_EXCEEDED', 'This repository is at its file limit.', {
        files: files.size,
        limit: SOURCE_LIMITS.maxFilesPerRepository,
      });
    }

    // 1: pre-flight against a simulated tree, so conflicts are found before any write.
    const simulated = new Map(files);
    for (const operation of input.operations) {
      this.preflight(operation, simulated);
      this.simulate(operation, simulated);
    }

    // 2: apply, compensating on failure.
    const applied: { readonly operation: ChangeOperation; readonly undo: () => Promise<void> }[] =
      [];
    const entries: FileRevisionEntry[] = [];
    const summary = input.summary ?? 'Source change set';

    try {
      for (const operation of input.operations) {
        const outcome = await this.apply(operation, state, summary);
        applied.push({ operation, undo: outcome.undo });
        entries.push(outcome.entry);
      }
    } catch (error) {
      let compensated = 0;
      for (const step of [...applied].reverse()) {
        try {
          await step.undo();
          compensated += 1;
        } catch {
          throw new SourceError(
            'SOURCE_ROLLBACK_FAILED',
            'A write failed and the earlier writes could not all be undone. Inspect the workspace.',
            { compensated, applied: applied.length },
          );
        }
      }
      const reason = error instanceof SourceError ? error.code : 'SOURCE_CHANGE_SET_FAILED';
      throw new SourceError(
        'SOURCE_CHANGE_SET_FAILED',
        'The change set was rolled back; nothing was kept.',
        {
          reason,
          compensated,
        },
      );
    }

    return {
      projectId: state.projectId,
      workspaceId: state.workspaceId,
      applied: entries.length,
      entries,
      rootRevision: await this.port.rootRevision(state.workspaceId),
    };
  }

  /** Convenience wrappers: one operation, same guarantees. */
  async createFile(
    ownerRef: string,
    input: {
      projectId: string;
      workspaceId?: string;
      path: string;
      content: string;
      summary?: string;
    },
  ): Promise<ChangeSetResult> {
    return this.changeSet(ownerRef, {
      projectId: input.projectId,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      operations: [{ op: 'create', path: input.path, content: input.content }],
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    });
  }

  async updateFile(
    ownerRef: string,
    input: {
      projectId: string;
      workspaceId?: string;
      path: string;
      content: string;
      expectedRevision: number;
      summary?: string;
    },
  ): Promise<ChangeSetResult> {
    return this.changeSet(ownerRef, {
      projectId: input.projectId,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      operations: [
        {
          op: 'update',
          path: input.path,
          content: input.content,
          expectedRevision: input.expectedRevision,
        },
      ],
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    });
  }

  async deleteFile(
    ownerRef: string,
    input: { projectId: string; workspaceId?: string; path: string; expectedRevision?: number },
  ): Promise<ChangeSetResult> {
    return this.changeSet(ownerRef, {
      projectId: input.projectId,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      operations: [
        {
          op: 'delete',
          path: input.path,
          ...(input.expectedRevision === undefined
            ? {}
            : { expectedRevision: input.expectedRevision }),
        },
      ],
    });
  }

  async createDirectory(
    ownerRef: string,
    input: { projectId: string; workspaceId?: string; path: string },
  ): Promise<ChangeSetResult> {
    return this.changeSet(ownerRef, {
      projectId: input.projectId,
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      operations: [{ op: 'create-directory', path: input.path }],
    });
  }

  // -- change set internals ------------------------------------------------

  private pathsOf(operation: ChangeOperation): string[] {
    switch (operation.op) {
      case 'create':
      case 'update':
      case 'delete':
      case 'create-directory':
        return [operation.path];
      case 'move':
        return [operation.fromPath];
      case 'rename':
        return [operation.path];
      default:
        return [];
    }
  }

  private preflight(operation: ChangeOperation, tree: ReadonlyMap<string, SourceTreeNode>): void {
    const requireFile = (path: string): SourceTreeNode => {
      const node = tree.get(path);
      if (node === undefined || node.type !== 'file') {
        throw new SourceError('SOURCE_PATH_NOT_FOUND', `"${path}" does not exist as a file.`, {
          path,
        });
      }
      return node;
    };

    switch (operation.op) {
      case 'create':
        if (tree.has(operation.path)) {
          throw new SourceError('SOURCE_PATH_CONFLICT', `"${operation.path}" already exists.`, {
            path: operation.path,
          });
        }
        return;
      case 'update': {
        const node = requireFile(operation.path);
        if (node.revision !== operation.expectedRevision) {
          throw new SourceError(
            'SOURCE_REVISION_CONFLICT',
            `"${operation.path}" changed since you loaded it.`,
            { path: operation.path, expected: operation.expectedRevision, actual: node.revision },
          );
        }
        return;
      }
      case 'delete': {
        const node = requireFile(operation.path);
        if (
          operation.expectedRevision !== undefined &&
          node.revision !== operation.expectedRevision
        ) {
          throw new SourceError(
            'SOURCE_REVISION_CONFLICT',
            `"${operation.path}" changed since you loaded it.`,
            { path: operation.path, expected: operation.expectedRevision, actual: node.revision },
          );
        }
        return;
      }
      case 'create-directory':
        if (tree.has(operation.path)) {
          throw new SourceError('SOURCE_PATH_CONFLICT', `"${operation.path}" already exists.`, {
            path: operation.path,
          });
        }
        return;
      case 'move':
        requireFile(operation.fromPath);
        return;
      case 'rename':
        requireFile(operation.path);
        return;
      default:
        return;
    }
  }

  private simulate(operation: ChangeOperation, tree: Map<string, SourceTreeNode>): void {
    const stamp = { revision: 1, updatedAt: this.now().toISOString() };
    switch (operation.op) {
      case 'create':
        tree.set(operation.path, { path: operation.path, type: 'file', ...stamp });
        return;
      case 'update':
        tree.set(operation.path, { path: operation.path, type: 'file', ...stamp });
        return;
      case 'delete':
        tree.delete(operation.path);
        return;
      case 'create-directory':
        tree.set(operation.path, { path: operation.path, type: 'directory', ...stamp });
        return;
      case 'move': {
        const source = tree.get(operation.fromPath);
        tree.delete(operation.fromPath);
        const base = operation.fromPath.split('/').pop() ?? operation.fromPath;
        const target = operation.toDirectory === '' ? base : `${operation.toDirectory}/${base}`;
        tree.set(target, { path: target, type: 'file', ...stamp });
        if (source === undefined) return;
        return;
      }
      case 'rename': {
        const source = tree.get(operation.path);
        tree.delete(operation.path);
        const parent = operation.path.includes('/')
          ? operation.path.slice(0, operation.path.lastIndexOf('/'))
          : '';
        const target = parent === '' ? operation.newName : `${parent}/${operation.newName}`;
        tree.set(target, { path: target, type: 'file', ...stamp });
        if (source === undefined) return;
        return;
      }
      default:
        return;
    }
  }

  /** Creates any missing parent directories, returning what it created. */
  private async ensureParents(workspaceId: string, path: string): Promise<string[]> {
    if (!path.includes('/')) return [];
    const segments = path.split('/').slice(0, -1);
    const existing = new Set(
      (await this.port.listAll(workspaceId))
        .filter((node) => node.type === 'directory')
        .map((node) => node.path),
    );
    const created: string[] = [];
    let current = '';
    for (const segment of segments) {
      current = current === '' ? segment : `${current}/${segment}`;
      if (existing.has(current)) continue;
      await this.port.createDirectory(workspaceId, current);
      created.push(current);
    }
    return created;
  }

  private async apply(
    operation: ChangeOperation,
    state: RepositoryState,
    summary: string,
  ): Promise<{ entry: FileRevisionEntry; undo: () => Promise<void> }> {
    const ws = state.workspaceId;
    const remember = (
      path: string,
      node: { revision: number },
      contentHash: string | null,
      size: number,
    ) => {
      const next = new Map(state.history.knownState());
      next.set(path, { revision: node.revision, size, contentHash, type: 'file' });
      state.history.remember(next);
    };

    switch (operation.op) {
      case 'create': {
        const createdDirectories = await this.ensureParents(ws, operation.path);
        const created = await this.port.createFile(ws, operation.path, operation.content);
        const size = byteLength(operation.content);
        const hash = contentHashOf(operation.content);
        remember(operation.path, created, hash, size);
        return {
          entry: state.history.record({
            path: operation.path,
            changeKind: 'created',
            revision: created.revision,
            size,
            contentHash: hash,
            actor: 'source-api',
            summary,
          }),
          undo: async () => {
            await this.port.deleteFile(ws, operation.path);
            for (const directory of [...createdDirectories].reverse()) {
              await this.port.deleteDirectory(ws, directory);
            }
          },
        };
      }
      case 'update': {
        const before = await this.port.readFile(ws, operation.path);
        const updated = await this.port.updateFile(
          ws,
          operation.path,
          operation.content,
          operation.expectedRevision,
        );
        const size = byteLength(operation.content);
        const hash = contentHashOf(operation.content);
        remember(operation.path, updated, hash, size);
        return {
          entry: state.history.record({
            path: operation.path,
            changeKind: 'modified',
            revision: updated.revision,
            size,
            contentHash: hash,
            actor: 'source-api',
            summary,
          }),
          undo: async () => {
            await this.port.updateFile(ws, operation.path, before.content, updated.revision);
          },
        };
      }
      case 'delete': {
        const before = await this.port.readFile(ws, operation.path);
        await this.port.deleteFile(ws, operation.path);
        const next = new Map(state.history.knownState());
        next.delete(operation.path);
        state.history.remember(next);
        return {
          entry: state.history.record({
            path: operation.path,
            changeKind: 'deleted',
            revision: 0,
            size: byteLength(before.content),
            contentHash: null,
            actor: 'source-api',
            summary,
          }),
          undo: async () => {
            await this.port.createFile(ws, operation.path, before.content);
          },
        };
      }
      case 'create-directory': {
        const created = await this.port.createDirectory(ws, operation.path);
        return {
          entry: state.history.record({
            path: operation.path,
            changeKind: 'directory-created',
            revision: created.revision,
            size: 0,
            contentHash: null,
            actor: 'source-api',
            summary,
          }),
          undo: async () => {
            await this.port.deleteDirectory(ws, operation.path);
          },
        };
      }
      case 'move': {
        const moved = await this.port.moveNode(ws, operation.fromPath, operation.toDirectory);
        const next = new Map(state.history.knownState());
        next.delete(operation.fromPath);
        state.history.remember(next);
        return {
          entry: state.history.record({
            path: moved.path,
            changeKind: 'moved',
            revision: moved.revision,
            size: 0,
            contentHash: null,
            actor: 'source-api',
            summary: `${summary} (from ${operation.fromPath})`,
          }),
          undo: async () => {
            const directory = operation.fromPath.includes('/')
              ? operation.fromPath.slice(0, operation.fromPath.lastIndexOf('/'))
              : '';
            if (directory === '') {
              await this.port.renameNode(ws, moved.path, operation.fromPath);
              return;
            }
            await this.port.moveNode(ws, moved.path, directory);
          },
        };
      }
      case 'rename': {
        const renamed = await this.port.renameNode(ws, operation.path, operation.newName);
        const next = new Map(state.history.knownState());
        next.delete(operation.path);
        state.history.remember(next);
        return {
          entry: state.history.record({
            path: renamed.path,
            changeKind: 'moved',
            revision: renamed.revision,
            size: 0,
            contentHash: null,
            actor: 'source-api',
            summary: `${summary} (renamed from ${operation.path})`,
          }),
          undo: async () => {
            const name = operation.path.split('/').pop() ?? operation.path;
            await this.port.renameNode(ws, renamed.path, name);
          },
        };
      }
      default:
        throw new SourceError('SOURCE_INVALID_REQUEST', 'Unsupported change operation.');
    }
  }

  // -- snapshots -----------------------------------------------------------

  private async liveManifest(state: RepositoryState): Promise<{
    manifest: ManifestEntry[];
    blobs: string[];
  }> {
    const nodes = await this.port.listAll(state.workspaceId);
    const files = nodes.filter((node) => node.type === 'file');
    if (files.length > SOURCE_LIMITS.maxFilesPerRepository) {
      throw new SourceError(
        'SOURCE_LIMIT_EXCEEDED',
        'This repository has too many files to snapshot.',
        {
          files: files.length,
          limit: SOURCE_LIMITS.maxFilesPerRepository,
        },
      );
    }
    const manifest: ManifestEntry[] = [];
    const blobs: string[] = [];
    for (const node of files) {
      const file = await this.port.readFile(state.workspaceId, node.path);
      const size = assertContentSize(node.path, file.content);
      manifest.push({ path: node.path, contentHash: contentHashOf(file.content), size });
      blobs.push(file.content);
    }
    return { manifest, blobs };
  }

  async createSnapshot(
    ownerRef: string,
    input: {
      projectId: string;
      workspaceId?: string;
      kind?: 'manual' | 'automatic';
      label?: string;
      note?: string;
    },
  ): Promise<SnapshotView> {
    const state = await this.repository(ownerRef, input.projectId, input.workspaceId);
    const { manifest, blobs } = await this.liveManifest(state);
    for (const content of blobs) await this.store.put(content);

    const built = buildManifest(manifest);
    const kind = input.kind ?? 'manual';
    const detail: SnapshotDetail = {
      id: this.generateId(),
      projectId: state.projectId,
      workspaceId: state.workspaceId,
      kind,
      label: (input.label ?? (kind === 'automatic' ? 'Automatic snapshot' : 'Snapshot')).slice(
        0,
        120,
      ),
      note: (input.note ?? '').slice(0, 500),
      manifestHash: built.hash,
      files: built.files.length,
      bytes: built.bytes,
      createdAt: this.now().toISOString(),
      manifest: built.files,
    };

    state.snapshots.push(detail);
    this.pruneSnapshots(state);
    return this.viewOf(detail);
  }

  private pruneSnapshots(state: RepositoryState): void {
    const automatic = state.snapshots.filter((snapshot) => snapshot.kind === 'automatic');
    if (automatic.length > SOURCE_LIMITS.maxAutomaticSnapshots) {
      const excess = automatic.length - SOURCE_LIMITS.maxAutomaticSnapshots;
      const doomed = new Set(automatic.slice(0, excess).map((snapshot) => snapshot.id));
      state.snapshots = state.snapshots.filter((snapshot) => !doomed.has(snapshot.id));
    }
    if (state.snapshots.length > SOURCE_LIMITS.maxSnapshots) {
      const excess = state.snapshots.length - SOURCE_LIMITS.maxSnapshots;
      const removable = state.snapshots
        .map((snapshot, index) => ({ snapshot, index }))
        .filter((entry) => entry.snapshot.kind === 'automatic')
        .slice(0, excess)
        .map((entry) => entry.snapshot.id);
      const doomed = new Set(removable);
      state.snapshots = state.snapshots.filter((snapshot) => !doomed.has(snapshot.id));
    }
  }

  private viewOf(detail: SnapshotDetail): SnapshotView {
    return {
      id: detail.id,
      projectId: detail.projectId,
      workspaceId: detail.workspaceId,
      kind: detail.kind,
      label: detail.label,
      note: detail.note,
      manifestHash: detail.manifestHash,
      files: detail.files,
      bytes: detail.bytes,
      createdAt: detail.createdAt,
    };
  }

  async listSnapshots(
    ownerRef: string,
    input: { projectId: string; workspaceId?: string },
  ): Promise<readonly SnapshotView[]> {
    const state = await this.repository(ownerRef, input.projectId, input.workspaceId);
    return [...state.snapshots].reverse().map((snapshot) => this.viewOf(snapshot));
  }

  async getSnapshot(
    ownerRef: string,
    input: { projectId: string; workspaceId?: string; snapshotId: string },
  ): Promise<SnapshotDetail> {
    const state = await this.repository(ownerRef, input.projectId, input.workspaceId);
    const snapshot = state.snapshots.find((candidate) => candidate.id === input.snapshotId);
    if (snapshot === undefined) {
      throw new SourceError('SOURCE_SNAPSHOT_NOT_FOUND', 'No snapshot with that id exists here.');
    }
    return snapshot;
  }

  /**
   * Restore a snapshot.
   *
   * A fresh automatic snapshot of the CURRENT tree is taken first, so a restore
   * is itself reversible. Files are then created, updated or removed to match
   * the snapshot exactly; history records the restore as its own actor.
   */
  async restoreSnapshot(
    ownerRef: string,
    input: { projectId: string; workspaceId?: string; snapshotId: string },
  ): Promise<{
    snapshotId: string;
    created: number;
    updated: number;
    deleted: number;
    preRestoreSnapshotId: string;
  }> {
    const state = await this.repository(ownerRef, input.projectId, input.workspaceId);
    const snapshot = await this.getSnapshot(ownerRef, input);
    const preRestore = await this.createSnapshot(ownerRef, {
      projectId: state.projectId,
      workspaceId: state.workspaceId,
      kind: 'automatic',
      label: 'Before restore',
      note: `Taken immediately before restoring "${snapshot.label}"`,
    });

    const nodes = await this.port.listAll(state.workspaceId);
    const current = new Map(
      nodes.filter((node) => node.type === 'file').map((node) => [node.path, node]),
    );
    const target = new Map(snapshot.manifest.map((entry) => [entry.path, entry]));

    let created = 0;
    let updated = 0;
    let deleted = 0;

    for (const [path, entry] of target) {
      const content = await this.store.get(entry.contentHash);
      if (content === null) {
        throw new SourceError(
          'SOURCE_SNAPSHOT_FAILED',
          `Snapshot content for "${path}" is no longer available in this store.`,
          { path },
        );
      }
      const existing = current.get(path);
      if (existing === undefined) {
        await this.port.createFile(state.workspaceId, path, content);
        created += 1;
      } else {
        const live = await this.port.readFile(state.workspaceId, path);
        if (contentHashOf(live.content) === entry.contentHash) continue;
        await this.port.updateFile(state.workspaceId, path, content, live.revision);
        updated += 1;
      }
      state.history.record({
        path,
        changeKind: existing === undefined ? 'created' : 'modified',
        revision: 0,
        size: entry.size,
        contentHash: entry.contentHash,
        actor: 'snapshot-restore',
        summary: `Restored from snapshot "${snapshot.label}"`,
      });
    }

    for (const path of current.keys()) {
      if (target.has(path)) continue;
      const live = await this.port.readFile(state.workspaceId, path);
      await this.port.deleteFile(state.workspaceId, path);
      deleted += 1;
      state.history.record({
        path,
        changeKind: 'deleted',
        revision: 0,
        size: byteLength(live.content),
        contentHash: null,
        actor: 'snapshot-restore',
        summary: `Removed by restore to snapshot "${snapshot.label}"`,
      });
    }

    // The tree changed underneath us; forget remembered state so the next
    // observation re-reads it honestly.
    state.history.remember(new Map());

    return {
      snapshotId: snapshot.id,
      created,
      updated,
      deleted,
      preRestoreSnapshotId: preRestore.id,
    };
  }

  async compareSnapshots(
    ownerRef: string,
    input: {
      projectId: string;
      workspaceId?: string;
      fromSnapshotId: string;
      toSnapshotId: string;
    },
  ): Promise<SnapshotComparison> {
    const from = await this.resolveSide(ownerRef, input, input.fromSnapshotId);
    const to = await this.resolveSide(ownerRef, input, input.toSnapshotId);
    return compareManifests(from.label, from.manifest, to.label, to.manifest);
  }

  /** `current` names the live tree, so a snapshot can be compared with today. */
  private async resolveSide(
    ownerRef: string,
    input: { projectId: string; workspaceId?: string },
    side: string,
  ): Promise<{ readonly label: string; readonly manifest: SourceManifest['files'] }> {
    if (side === 'current') {
      const state = await this.repository(ownerRef, input.projectId, input.workspaceId);
      const { manifest } = await this.liveManifest(state);
      return { label: 'current', manifest };
    }
    const snapshot = await this.getSnapshot(ownerRef, { ...input, snapshotId: side });
    return { label: snapshot.label, manifest: snapshot.manifest };
  }

  /** Deterministic manifest of the CURRENT tree, for optional GitHub sync. */
  async manifest(
    ownerRef: string,
    input: { projectId: string; workspaceId?: string },
  ): Promise<SourceManifest> {
    const state = await this.repository(ownerRef, input.projectId, input.workspaceId);
    const { manifest } = await this.liveManifest(state);
    const built = buildManifest(manifest);
    return {
      projectId: state.projectId,
      workspaceId: state.workspaceId,
      generatedAt: this.now().toISOString(),
      manifestHash: built.hash,
      files: built.files,
    };
  }

  /** What this store holds, so nobody mistakes it for durable production storage. */
  storage(): {
    readonly content: ReturnType<ContentStore['stats']>;
    readonly repositories: number;
  } {
    return { content: this.store.stats(), repositories: this.repositories.size };
  }
}
