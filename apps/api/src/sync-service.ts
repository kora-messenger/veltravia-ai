import { isProjectError, type ProjectEngine } from '@veltravia/project-core';
import type { GitHubApiConnector } from './github.js';
import {
  SyncManager,
  type LocalProjectPort,
  type RemotePort,
  type RemoteSnapshot,
  type RepositoryChoice,
  type BranchChoice,
  type PublishInput,
} from '@veltravia/sync-core';

/**
 * GitHub synchronisation wiring (Step 40, phase 3).
 *
 * Both ports are adapters over things that already exist:
 *
 * - the LOCAL side is the same project engine every other feature writes
 *   through (no second store, no filesystem);
 * - the REMOTE side is the ONE existing GitHub connector runtime, so every
 *   scope check, allowlist check, token read and audit event is the connector's
 *   own. There is no second GitHub client and no second credential store here.
 *
 * GitHub is optional: nothing in this file is on the path of creating, editing
 * or exporting a project.
 */

/** How many times a snapshot is re-read when the project changes underneath it. */
const SNAPSHOT_ATTEMPTS = 3;

function isNotFound(error: unknown): boolean {
  return isProjectError(error) && error.code === 'FILE_NOT_FOUND';
}

export interface LocalPortOptions {
  readonly projectEngine: ProjectEngine;
}

export function createLocalProjectPort(options: LocalPortOptions): LocalProjectPort {
  const projects = options.projectEngine.projects;
  const workspaces = options.projectEngine.workspaces;
  const files = options.projectEngine.files;

  /** Creates every missing parent directory of a path, shallowest first. */
  async function ensureParents(workspaceId: string, path: string): Promise<void> {
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join('/');
      try {
        await files.getNode(workspaceId, directory);
      } catch (error) {
        if (isNotFound(error)) await files.createDirectory(workspaceId, directory);
        else throw error;
      }
    }
  }

  return {
    async resolveProject(input) {
      let project;
      try {
        project = await projects.getProject(input.projectId);
      } catch {
        return null;
      }
      // Somebody else's project answers exactly like a missing one.
      if (project.ownerRef !== input.ownerRef) return null;
      if (project.status === 'deleted') return null;
      const list = await workspaces.listWorkspaces(project.id);
      const active = list.filter((workspace) => workspace.status !== 'archived');
      const chosen = active[0] ?? list[0];
      if (chosen === undefined) return null;
      return { projectId: project.id, workspaceId: chosen.id, name: project.name };
    },

    async readSnapshot(workspaceId) {
      // Read, then confirm the workspace did not change while reading. A
      // mixture of two revisions would make files look added or deleted.
      for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt += 1) {
        const before = await workspaces.getWorkspace(workspaceId);
        const nodes = await files.listAll(workspaceId);
        const read: { path: string; content: string }[] = [];
        for (const node of nodes) {
          if (node.type !== 'file') continue;
          const file = await files.readFile(workspaceId, node.path);
          read.push({ path: node.path, content: file.content });
        }
        const after = await workspaces.getWorkspace(workspaceId);
        if (before !== null && after !== null && before.revision === after.revision) {
          return { revision: after.revision, files: read };
        }
      }
      throw new Error('The project changed while it was being read.');
    },

    async currentRevision(workspaceId) {
      const workspace = await workspaces.getWorkspace(workspaceId);
      return workspace?.revision ?? 0;
    },

    async writeFile(workspaceId, path, content) {
      await ensureParents(workspaceId, path);
      try {
        const existing = await files.getNode(workspaceId, path);
        if (existing.type !== 'file') throw new Error('that path is not a file');
        await files.updateFile(workspaceId, path, {
          content,
          expectedRevision: existing.revision,
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await files.createFile(workspaceId, { path, content });
      }
    },

    async deleteFile(workspaceId, path) {
      try {
        await files.deleteFile(workspaceId, path);
      } catch (error) {
        // Already gone is the outcome we wanted.
        if (!isNotFound(error)) throw error;
      }
    },
  };
}

export interface RemotePortOptions {
  readonly github: GitHubApiConnector;
  /**
   * Establishes the connection the first time it is needed. buildApp is
   * synchronous, so this is deferred rather than awaited at boot. It calls the
   * connector's own connect(), which performs the same one-time proof read the
   * ConnectorManager performs - without going through the manager, because the
   * connector id is shared with the coding agent's instance and registering a
   * second one under the same id would leave THIS runtime disconnected.
   */
  readonly ensureConnected?: () => Promise<void>;
}

/**
 * The remote port, implemented ENTIRELY over the existing connector runtime.
 *
 * Every call names a declared operation, so the connector's own allowlist,
 * scope, token handling and audit apply unchanged. Nothing here can reach an
 * endpoint the connector does not declare.
 */
export function createRemotePort(options: RemotePortOptions): RemotePort {
  const runtime = options.github.runtime;

  // Connect once, on first use. The default calls the connector's own
  // connect(), which performs the same one-time proof read the ConnectorManager
  // performs. A failed connection is remembered as failed: operations then
  // report it honestly instead of retrying behind the user's back.
  let ready: Promise<void> | null = null;
  const ensureReady = (): Promise<void> => {
    if (ready === null) {
      const connect = options.ensureConnected ?? (() => options.github.runtime.connector.connect());
      ready = connect().catch(() => undefined);
    }
    return ready;
  };

  async function run<T>(operationId: string, input: Record<string, unknown>): Promise<T> {
    await ensureReady();
    return (await runtime.executeOperation(operationId, input)) as T;
  }

  return {
    async listRepositories() {
      const result = await run<{ repositories: RepositoryChoice[] }>(
        'github.repositories.list',
        {},
      );
      return result.repositories.map((repo): RepositoryChoice => ({
        owner: repo.owner,
        repository: repo.repository,
        visibility: repo.visibility,
        defaultBranch: repo.defaultBranch,
        description: repo.description,
      }));
    },

    async listBranches(owner, repository) {
      const result = await run<{ branches: { name: string; sha: string }[] }>(
        'github.branches.list',
        { owner, repository },
      );
      const repo = await run<{ defaultBranch?: string }>('github.repositories.get', {
        owner,
        repository,
      });
      return result.branches.map((branch): BranchChoice => ({
        name: branch.name,
        headSha: branch.sha,
        isDefault: branch.name === repo.defaultBranch,
      }));
    },

    async readSnapshot(owner, repository, branch): Promise<RemoteSnapshot> {
      // The tree lists every file with its blob sha; text is fetched one file
      // at a time only when it is actually needed.
      const tree = await run<{
        headSha: string;
        files: { path: string; sha: string; size: number }[];
        skipped: number;
        truncated: boolean;
      }>('github.tree.get', { owner, repository, branch });
      return {
        headSha: tree.headSha,
        files: tree.files.map((file) => ({
          path: file.path,
          // A blob sha identifies exact content, which is all a comparison needs.
          hashOfText: file.sha,
          size: file.size,
          notText: null,
        })),
        skipped: tree.skipped,
        truncated: tree.truncated,
      };
    },

    async readText(owner, repository, branch, path) {
      // The connector reports `encoding: 'utf-8'` for text it decoded and leaves
      // anything else as a listing marker. Only that yields null "not text".
      // A FAILURE is NOT null: an unreadable file used to look like a binary one
      // and be skipped in silence, which is how a broken read could quietly
      // drop a file from a sync. Errors propagate and are reported.
      const file = await run<{ content: string | null; encoding: string }>('github.contents.get', {
        owner,
        repository,
        branch,
        path,
      });
      return file.encoding === 'utf-8' && typeof file.content === 'string' ? file.content : null;
    },

    async publish(input: PublishInput) {
      const result = await run<{ commit: { sha: string } }>('github.commit.publish', {
        owner: input.owner,
        repository: input.repository,
        branch: input.branch,
        expectedHeadSha: input.expectedHeadSha,
        message: input.message,
        changes: input.changes.map((change) => ({
          path: change.path,
          content: change.content,
        })),
      });
      return { commitSha: result.commit.sha };
    },
  };
}

export interface SyncServiceOptions {
  readonly projectEngine: ProjectEngine;
  readonly github: GitHubApiConnector;
  readonly ensureConnected?: () => Promise<void>;
  readonly now?: () => Date;
}

export function createSyncService(options: SyncServiceOptions): SyncManager {
  return new SyncManager({
    local: createLocalProjectPort({ projectEngine: options.projectEngine }),
    remote: createRemotePort({
      github: options.github,
      ...(options.ensureConnected === undefined
        ? {}
        : { ensureConnected: options.ensureConnected }),
    }),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}
