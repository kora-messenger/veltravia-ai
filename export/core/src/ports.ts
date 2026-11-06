/**
 * What the export engine needs from project storage, and nothing else.
 *
 * It is deliberately narrower than the source repository: read-only, no
 * mutation, no host filesystem. Any storage that can answer these four
 * questions (the in-memory project engine today, a database later) can back an
 * export without the engine changing.
 */

export interface ExportNode {
  readonly path: string;
  readonly type: 'file' | 'directory';
  /** The node's own revision. A file whose revision moves has changed. */
  readonly revision: number;
}

export interface ExportSourcePort {
  /**
   * Resolve a project the OWNER may export. Returns null when the project does
   * not exist, is deleted, or belongs to someone else: the caller must not be
   * able to tell those apart.
   */
  resolveProject(input: { readonly ownerRef: string; readonly projectId: string }): Promise<{
    readonly projectId: string;
    readonly workspaceId: string;
    readonly name: string;
  } | null>;

  /** Every node in the workspace. */
  listNodes(workspaceId: string): Promise<readonly ExportNode[]>;

  /** One counter that moves whenever anything in the workspace changes. */
  workspaceRevision(workspaceId: string): Promise<number>;

  /**
   * The COMPLETE content of one file. Implementations must not truncate; a
   * file they cannot return whole must throw instead.
   */
  readFile(
    workspaceId: string,
    path: string,
  ): Promise<{ readonly revision: number; readonly content: string }>;
}

/** Where finished archives live until they expire. */
export interface ArchiveStore {
  put(entry: StoredArchive): void;
  get(exportId: string): StoredArchive | undefined;
  delete(exportId: string): void;
  /** Ids held for one owner, oldest first. */
  idsFor(ownerRef: string): readonly string[];
  size(): number;
}

export interface StoredArchive {
  readonly exportId: string;
  readonly ownerRef: string;
  readonly projectId: string;
  readonly bytes: Uint8Array;
  readonly expiresAt: number;
}
