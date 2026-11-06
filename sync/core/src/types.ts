/**
 * GitHub synchronisation types.
 *
 * Nothing in a plan, a history entry, an error or a status carries a secret or
 * a token. Plans and history name PATHS, hashes and counts. File text appears
 * only in a conflict's two sides, only on the one call that asks for it, and
 * only after the same secret scan the export uses.
 */

export const SYNC_LIMITS = {
  /** Most files one sync commit may change (the connector's own ceiling). */
  maxChangesPerCommit: 500,
  /** Largest single file synchronised, in bytes. Matches source storage. */
  maxFileBytes: 512 * 1024,
  /** Most files read from a remote branch in one sync. */
  maxRemoteFiles: 2000,
  /** History entries kept per project. */
  maxHistoryEntries: 200,
  /** How long an unapproved plan stays valid, in milliseconds. */
  planTtlMs: 15 * 60 * 1000,
  /** Longest commit message accepted, in characters. */
  maxMessageLength: 2000,
} as const;

/** The repository and branch a project is connected to. */
export interface SyncConnection {
  readonly projectId: string;
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
  readonly connectedAt: string;
  /** Head of the branch at the last successful sync; null before the first. */
  readonly lastSyncedCommit: string | null;
  readonly lastSyncedAt: string | null;
}

/** What a repository looks like to someone choosing one. No secrets. */
export interface RepositoryChoice {
  readonly owner: string;
  readonly repository: string;
  readonly visibility: 'public' | 'private' | 'unknown';
  readonly defaultBranch: string;
  readonly description: string;
}

export interface BranchChoice {
  readonly name: string;
  readonly headSha: string;
  readonly isDefault: boolean;
}

// -- file state -------------------------------------------------------------

/** A file as one side holds it: a path, a content hash and a size. */
export interface FileState {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
}

/** What both sides agreed on at the last sync: path -> hash. */
export type BaseSnapshot = ReadonlyMap<string, string>;

export type ChangeKind = 'add' | 'modify' | 'delete' | 'rename';

/** A change to publish to the remote. Content is attached only at commit time. */
export interface PlannedChange {
  readonly kind: ChangeKind;
  readonly path: string;
  /** For a rename, where the file was. */
  readonly fromPath?: string;
  readonly hash: string | null;
  readonly size: number;
}

/** A change to bring into the project from the remote. */
export interface IncomingChange {
  readonly kind: 'add' | 'modify' | 'delete';
  readonly path: string;
  readonly hash: string | null;
  readonly size: number;
}

// -- conflicts ---------------------------------------------------------------

export type ConflictKind =
  | 'both-modified' // changed on both sides, differently
  | 'both-added' // added on both sides, differently
  | 'local-deleted-remote-modified'
  | 'remote-deleted-local-modified'
  | 'rename-conflict'; // one side renamed what the other side changed

export type ConflictResolution = 'keep-local' | 'keep-remote' | 'manual';

export interface Conflict {
  readonly id: string;
  readonly path: string;
  readonly kind: ConflictKind;
  /** null when that side has no file (deleted, or never existed). */
  readonly localHash: string | null;
  readonly remoteHash: string | null;
  readonly baseHash: string | null;
  /** One plain sentence for a person. */
  readonly summary: string;
  readonly resolution: ConflictResolution | null;
}

/** Why a file was left out of a sync. Fixed words, never content. */
export type SkipReason =
  | 'credential-file'
  | 'secret-in-content'
  | 'too-large'
  | 'not-text' // a remote binary file: left exactly as it is
  | 'unreadable'
  | 'not-a-file'; // a symlink or submodule

export interface SkippedFile {
  readonly path: string;
  readonly side: 'local' | 'remote';
  readonly reason: SkipReason;
  readonly detail: string;
}

// -- the plan ----------------------------------------------------------------

export type PlanStatus =
  | 'needs-approval' // something remote changes and a person must say yes
  | 'ready' // nothing risky: can be applied
  | 'conflicts' // unresolved conflicts block applying
  | 'in-sync' // nothing to do
  | 'applied'
  | 'cancelled'
  | 'expired'
  | 'failed';

/** Why a plan needs a person's approval before it touches the remote. */
export type ApprovalReason =
  | 'first-sync' // the first push of a project into a repository
  | 'remote-has-content' // the repository already holds files
  | 'deletes-remote-files' // the commit removes files from the remote
  | 'default-branch' // the target is the repository's default branch
  | 'conflict-resolution'; // a resolution that rewrites remote content

export interface SyncPlan {
  readonly planId: string;
  readonly projectId: string;
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
  readonly status: PlanStatus;
  /** First sync, or a later one. */
  readonly mode: 'initial' | 'update';
  /** The remote head this plan was made against; publishing requires it unchanged. */
  readonly remoteHead: string;
  /** The project revision this plan was made against. */
  readonly localRevision: number;
  readonly push: readonly PlannedChange[];
  readonly pull: readonly IncomingChange[];
  readonly conflicts: readonly Conflict[];
  readonly skipped: readonly SkippedFile[];
  readonly unchanged: number;
  readonly approvalReasons: readonly ApprovalReason[];
  readonly approved: boolean;
  readonly message: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

// -- history -----------------------------------------------------------------

export type HistoryOutcome = 'success' | 'failure' | 'cancelled' | 'conflicts';

/** One record of a sync attempt. No file content, no token, ever. */
export interface SyncHistoryEntry {
  readonly entryId: string;
  readonly projectId: string;
  readonly owner: string;
  readonly repository: string;
  readonly branch: string;
  readonly outcome: HistoryOutcome;
  readonly commitSha: string | null;
  readonly message: string;
  readonly at: string;
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly pulled: number;
  readonly conflicts: number;
  readonly approval: 'approved' | 'not-required' | 'declined';
  readonly failureCode: string | null;
}

export type SyncErrorCode =
  | 'SYNC_NOT_FOUND'
  | 'SYNC_NOT_CONNECTED'
  | 'SYNC_ALREADY_CONNECTED'
  | 'SYNC_INVALID_REQUEST'
  | 'SYNC_SECRET_REJECTED'
  | 'SYNC_REPOSITORY_NOT_ALLOWED'
  | 'SYNC_BRANCH_NOT_FOUND'
  | 'SYNC_CONFLICTS_UNRESOLVED'
  | 'SYNC_APPROVAL_REQUIRED'
  | 'SYNC_PLAN_STALE'
  | 'SYNC_PLAN_EXPIRED'
  | 'SYNC_PLAN_NOT_ACTIVE'
  | 'SYNC_NOTHING_TO_SYNC'
  | 'SYNC_REMOTE_CHANGED'
  | 'SYNC_REMOTE_TRUNCATED'
  | 'SYNC_TOO_MANY_CHANGES'
  | 'SYNC_GITHUB_FAILED'
  | 'SYNC_CANCELLED'
  | 'SYNC_UNSUPPORTED'
  | 'SYNC_INTERNAL';
