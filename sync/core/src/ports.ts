import type { BranchChoice, RepositoryChoice } from './types.js';

/**
 * What the sync engine needs from the world. Two ports, and nothing else.
 *
 * LocalProjectPort is the project (the same storage export reads). RemotePort is
 * GitHub, and is implemented on the EXISTING GitHub connector: there is no
 * second GitHub client and no second credential. Neither port ever hands the
 * engine a token.
 */

export interface LocalFile {
  readonly path: string;
  readonly content: string;
}

export interface LocalSnapshot {
  readonly files: readonly LocalFile[];
  /** One counter that moves whenever anything in the project changes. */
  readonly revision: number;
}

export interface LocalProjectPort {
  /** Resolve a project the owner may sync; null if missing OR somebody else's. */
  resolveProject(input: { readonly ownerRef: string; readonly projectId: string }): Promise<{
    readonly projectId: string;
    readonly workspaceId: string;
    readonly name: string;
  } | null>;

  /**
   * Every file, read as one consistent snapshot. Throws if the project changed
   * while it was being read, rather than returning a mixture.
   */
  readSnapshot(workspaceId: string): Promise<LocalSnapshot>;

  currentRevision(workspaceId: string): Promise<number>;

  /** Create or replace one file. Used only when bringing remote changes in. */
  writeFile(workspaceId: string, path: string, content: string): Promise<void>;

  deleteFile(workspaceId: string, path: string): Promise<void>;
}

export interface RemoteFile {
  readonly path: string;
  readonly hashOfText: string | null;
  readonly size: number;
  /** Why no text is available, when it is not. */
  readonly notText: 'binary' | 'too-large' | 'unreadable' | null;
}

export interface RemoteSnapshot {
  readonly headSha: string;
  readonly files: readonly RemoteFile[];
  /** Symlinks, submodules and other non-file entries that were left alone. */
  readonly skipped: number;
  readonly truncated: boolean;
}

export interface PublishInput {
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
  readonly expectedHeadSha: string;
  readonly message: string;
  readonly changes: readonly { readonly path: string; readonly content: string | null }[];
}

export interface RemotePort {
  /** Repositories the connector is allowed to touch. Never more. */
  listRepositories(): Promise<readonly RepositoryChoice[]>;
  listBranches(owner: string, repository: string): Promise<readonly BranchChoice[]>;
  /** Every file on a branch. Text is hashed here; it is not returned in bulk. */
  readSnapshot(owner: string, repository: string, branch: string): Promise<RemoteSnapshot>;
  /** The text of one remote file, or null if it is not text. */
  readText(owner: string, repository: string, branch: string, path: string): Promise<string | null>;
  /** One commit holding every change; fast-forward only. */
  publish(input: PublishInput): Promise<{ readonly commitSha: string }>;
}
