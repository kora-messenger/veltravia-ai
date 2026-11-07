/**
 * Isolated worker staging (Step 46, section 3).
 *
 * A worker used to write straight into the project workspace. It now writes
 * into a workspace of its own, and what it produced is turned into a change set
 * the Primary Agent can review. The project tree is untouched until an
 * integration applies that set.
 *
 * Reads are still served from the project: a worker sees the base revision, not
 * its own half-finished copy of somebody else's work.
 */

import type { ProjectEngine } from '@veltravia/project-core';

import { contentHash, normalizeChangePath } from '@veltravia/change-integration-core';

export interface StagedFile {
  readonly path: string;
  readonly op: 'create' | 'update';
  /** Content hash of the project file when the worker first wrote it. */
  readonly baseHash: string | null;
  readonly baseRevision: number | null;
  readonly content: string;
}

export interface WorkerStagingArea {
  readonly workerId: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly mainWorkspaceId: string;
  readonly stagingWorkspaceId: string;
  readonly allowedPaths: readonly string[];
  readonly excludedPaths: readonly string[];
  readonly allowedTools: readonly string[];
  readonly files: Map<string, StagedFile>;
  /** Project revision the worker saw when it started writing. */
  readonly baseRevision: number;
  readonly createdAt: string;
}

/**
 * Every staging area in this process.
 *
 * Process-local on purpose: a worker's writes live as long as the run that made
 * them. Once the change set is recorded, the artifact store holds the content
 * and the staging area is no longer needed.
 */
export class WorkerStagingRegistry {
  private readonly areas = new Map<string, WorkerStagingArea>();

  constructor(private readonly engine: ProjectEngine) {}

  get(workerId: string): WorkerStagingArea | null {
    return this.areas.get(workerId) ?? null;
  }

  list(): readonly WorkerStagingArea[] {
    return Array.from(this.areas.values());
  }

  /**
   * Opens a staging area for a worker.
   *
   * The workspace is named after the worker so an operator can tell where the
   * bytes came from, and it is created once per run.
   */
  async open(input: {
    readonly workerId: string;
    readonly projectId: string;
    readonly mainWorkspaceId: string;
    readonly taskId?: string | null;
    readonly allowedPaths?: readonly string[];
    readonly excludedPaths?: readonly string[];
    readonly allowedTools?: readonly string[];
  }): Promise<WorkerStagingArea> {
    const existing = this.areas.get(input.workerId);
    if (existing !== undefined) return existing;
    const workspace = await this.engine.workspaces.createWorkspace(input.projectId, {
      name: `worker ${input.workerId}`.slice(0, 80),
      metadata: { purpose: 'worker-staging', workerId: input.workerId },
    });
    const main = await this.engine.workspaces.getWorkspace(input.mainWorkspaceId);
    const area: WorkerStagingArea = {
      workerId: input.workerId,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      mainWorkspaceId: input.mainWorkspaceId,
      stagingWorkspaceId: workspace.id,
      allowedPaths: [...(input.allowedPaths ?? [])],
      excludedPaths: [...(input.excludedPaths ?? [])],
      allowedTools: [...(input.allowedTools ?? [])],
      files: new Map(),
      baseRevision: main.revision,
      createdAt: new Date().toISOString(),
    };
    this.areas.set(input.workerId, area);
    return area;
  }

  /**
   * Writes one file into the staging tree.
   *
   * The base hash is captured on first touch, from the project, so the change
   * set records what the worker actually started from rather than what it
   * assumed.
   */
  async write(area: WorkerStagingArea, path: string, content: string): Promise<StagedFile> {
    const safe = normalizeChangePath(path);
    if (safe === null) throw new Error(`"${path}" is not an acceptable path.`);
    let base: { hash: string | null; revision: number | null };
    try {
      const read = await this.engine.files.readFile(area.mainWorkspaceId, safe);
      base = { hash: contentHash(read.content), revision: read.node.revision };
    } catch {
      // The file is new in this proposal: there is nothing to preserve.
      base = { hash: null, revision: null };
    }
    const existing = area.files.get(safe);
    try {
      const current = await this.engine.files.readFile(area.stagingWorkspaceId, safe);
      await this.engine.files.updateFile(area.stagingWorkspaceId, safe, {
        content,
        expectedRevision: current.node.revision,
      });
    } catch {
      // The staging tree starts empty, so every ancestor has to exist before
      // the file can be written into it.
      const segments = safe.split('/').slice(0, -1);
      let prefix = '';
      for (const segment of segments) {
        prefix = prefix === '' ? segment : `${prefix}/${segment}`;
        try {
          await this.engine.files.createDirectory(area.stagingWorkspaceId, prefix);
        } catch {
          // Already there; the file create below reports any real problem.
        }
      }
      try {
        await this.engine.files.createFile(area.stagingWorkspaceId, { path: safe, content });
      } catch (error) {
        throw new Error(
          error instanceof Error ? error.message : `The staging tree refused ${safe}.`,
          { cause: error },
        );
      }
    }
    const entry: StagedFile = {
      path: safe,
      op: (base.hash ?? null) === null ? 'create' : 'update',
      baseHash: existing?.baseHash ?? base.hash,
      baseRevision: existing?.baseRevision ?? base.revision,
      content,
    };
    area.files.set(safe, entry);
    return entry;
  }

  /** Drops a staging area; the change set holds the content from here on. */
  async close(workerId: string): Promise<void> {
    this.areas.delete(workerId);
  }
}

/** The project workspace a worker's reads and staging are anchored to. */
export async function firstWorkspaceId(
  engine: ProjectEngine,
  projectId: string,
): Promise<string | null> {
  const workspaces = await engine.workspaces.listWorkspaces(projectId);
  const active = workspaces.filter(
    (workspace) =>
      workspace.status !== 'archived' && workspace.metadata?.['purpose'] !== 'worker-staging',
  );
  return (active[0] ?? workspaces[0])?.id ?? null;
}
