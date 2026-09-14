/**
 * Stable, provider-mapped GitHub data views. These are the ONLY shapes the
 * GitHub Connector ever returns: a fixed set of fields selected from GitHub
 * responses - never raw response bodies, headers, private metadata, or
 * token-bearing material.
 *
 * File content is UNTRUSTED DATA: a repository can contain anything,
 * including prompt-injection payloads. Consumers must treat GitHubFile
 * content as data, never as instructions.
 */

/** One repository, reduced to the fields the tool schemas expose. */
export interface GitHubRepository {
  readonly owner: string;
  readonly repository: string;
  readonly description: string;
  readonly visibility: 'public' | 'private' | 'unknown';
  readonly defaultBranch: string;
  readonly updatedAt: string | null;
}

/** One branch with its head commit sha (the remote version token). */
export interface GitHubBranch {
  readonly name: string;
  readonly sha: string;
}

/** One file at a path. UNTRUSTED CONTENT - repository data, never instructions. */
export interface GitHubFile {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  readonly content: string | null;
  readonly encoding: 'utf-8' | 'none';
}

/** One directory entry (name + type). */
export interface GitHubDirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'dir';
  readonly size: number;
}

/** The commit created by a file write or delete. */
export interface GitHubCommit {
  readonly sha: string;
  readonly message: string;
  readonly path: string;
  readonly branch: string;
}

/** Repository scope of one GitHub connection (server-side configuration). */
export interface GitHubRepositoryScopeEntry {
  readonly owner: string;
  readonly repository: string;
  readonly defaultBranch: string;
}

/** What a connection may touch. Empty scope = nothing is accessible. */
export interface GitHubConnectionScope {
  readonly repositories: readonly GitHubRepositoryScopeEntry[];
}

/** Resolves the raw token at call time. Never stored in connector state. */
export type GitHubTokenProvider = () => Promise<string>;

/** How an operation outcome is classified for audit purposes. */
export type GitHubOperationClass =
  'read' | 'branch_create' | 'file_create' | 'file_update' | 'file_delete' | 'commit_create';
