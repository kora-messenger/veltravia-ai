/**
 * Native project source storage: vocabulary (Step 31).
 *
 * The builder owns no filesystem. Everything here is expressed in terms of
 * CONTENT HASHES, PATHS and REVISION NUMBERS so the same model works against
 * an in-memory store today and object storage tomorrow.
 */

/** One path in a repository tree, as the storage layer sees it. */
export interface SourceFileView {
  readonly path: string;
  /** `file` or `directory`. */
  readonly type: 'file' | 'directory';
  /** Node revision from the project engine. */
  readonly revision: number;
  /** Bytes of the file content; `0` for directories. */
  readonly size: number;
  readonly updatedAt: string;
  /** Content hash, present for files only. */
  readonly contentHash: string | null;
}

/** Tree listing for one repository. */
export interface SourceTreeView {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly rootRevision: number;
  readonly files: readonly SourceFileView[];
  readonly directories: readonly string[];
  readonly totals: { readonly files: number; readonly bytes: number };
}

/** A file with content loaded. */
export interface SourceFileContent {
  readonly path: string;
  readonly revision: number;
  readonly size: number;
  readonly contentHash: string;
  readonly content: string;
  /** True when the file exceeded the read cap and was truncated. */
  readonly truncated: boolean;
}

/** One recorded change to one path. */
export interface FileRevisionEntry {
  readonly id: string;
  readonly path: string;
  readonly changeKind: 'created' | 'modified' | 'deleted' | 'moved' | 'directory-created';
  /** File revision AFTER the change; `0` for deletions. */
  readonly revision: number;
  readonly size: number;
  readonly contentHash: string | null;
  readonly actor: RevisionActor;
  readonly summary: string;
  readonly at: string;
}

/**
 * Who produced a change.
 *
 * `external-writer` is deliberately vague: the coding agent, the app builder
 * and the sandbox all write through the project engine, and the source layer
 * observes those writes rather than pretending it made them.
 */
export const REVISION_ACTORS = [
  'source-api',
  'ai-agent',
  'external-writer',
  'snapshot-restore',
] as const;
export type RevisionActor = (typeof REVISION_ACTORS)[number];

/** One requested change inside a change set. */
export type ChangeOperation =
  | { readonly op: 'create'; readonly path: string; readonly content: string }
  | {
      readonly op: 'update';
      readonly path: string;
      readonly content: string;
      /** Optimistic concurrency: the revision the caller believed was current. */
      readonly expectedRevision: number;
    }
  | { readonly op: 'delete'; readonly path: string; readonly expectedRevision?: number }
  | { readonly op: 'move'; readonly fromPath: string; readonly toDirectory: string }
  | { readonly op: 'rename'; readonly path: string; readonly newName: string }
  | { readonly op: 'create-directory'; readonly path: string };

/** Applied change set result, per operation, in request order. */
export interface ChangeSetResult {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly applied: number;
  readonly entries: readonly FileRevisionEntry[];
  /** Present when the whole change set was rolled back. */
  readonly rolledBack?: { readonly reason: string; readonly compensated: number };
  readonly rootRevision: number;
}

/** A stored snapshot of the whole repository tree. */
export interface SnapshotView {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly kind: 'manual' | 'automatic';
  readonly label: string;
  readonly note: string;
  /** Hash of the manifest itself; two identical trees share one manifest hash. */
  readonly manifestHash: string;
  readonly files: number;
  readonly bytes: number;
  readonly createdAt: string;
}

/** Snapshot plus its file manifest. */
export interface SnapshotDetail extends SnapshotView {
  readonly manifest: readonly {
    readonly path: string;
    readonly contentHash: string;
    readonly size: number;
  }[];
}

/** File-level comparison between two snapshots (or a snapshot and the tree). */
export interface SnapshotComparison {
  readonly from: string;
  readonly to: string;
  readonly added: readonly { readonly path: string; readonly size: number }[];
  readonly removed: readonly { readonly path: string; readonly size: number }[];
  readonly modified: readonly {
    readonly path: string;
    readonly fromSize: number;
    readonly toSize: number;
  }[];
  readonly unchanged: number;
  readonly summary: string;
}

/** Deterministic source manifest, exportable for optional GitHub synchronization. */
export interface SourceManifest {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly manifestHash: string;
  readonly files: readonly {
    readonly path: string;
    readonly contentHash: string;
    readonly size: number;
  }[];
}

/** Storage abstraction stats, so an operator can see what is held where. */
export interface ContentStoreStats {
  readonly blobs: number;
  readonly bytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
}

export const SOURCE_LIMITS = {
  /** Largest single file content accepted, in bytes. */
  maxFileBytes: 512 * 1024,
  /** Largest content returned by a read, in bytes. */
  maxReadBytes: 256 * 1024,
  /** Most operations in one atomic change set. */
  maxChangeSetOperations: 100,
  /** Most files a repository may hold before writes are refused. */
  maxFilesPerRepository: 2000,
  /** Most snapshots retained per repository. */
  maxSnapshots: 60,
  /** Most automatic snapshots retained per repository. */
  maxAutomaticSnapshots: 30,
  /** Largest blob the content store will hold. */
  maxBlobBytes: 2 * 1024 * 1024,
  /** Most bytes one repository's blobs may occupy. */
  maxRepositoryBytes: 64 * 1024 * 1024,
  /** Most history entries retained per repository. */
  maxHistoryEntries: 2000,
} as const;
