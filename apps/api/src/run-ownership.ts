import type { ProjectEngine } from '@veltravia/project-core';

/**
 * Who may start, read, cancel and approve which coding or generation run.
 *
 * Coding and generation runs were keyed by id alone and recorded no owner. Two
 * consequences, both reproduced live: any caller could start a run that writes
 * into another owner's project (the ids are in the request BODY, so the
 * parameter-based guard in project-access.ts never saw them), and anyone who
 * learned a run id could read, cancel or approve it.
 *
 * This is the same idea as the Step 39 testing ledger, shared:
 *  - Starting needs a project the caller owns and a workspace of that project.
 *  - A run is visible only to the owner who started it.
 *  - Someone else's run and a run that does not exist answer the same.
 *  - `scopeOf` tells the project tools which workspace a run was started on, so a
 *    run can touch only that workspace. The run id reaches the tool as the
 *    invocation's correlationId, which the server-side manager sets (never model
 *    input).
 */

export class RunAccessError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('That project or run was not found.');
    this.name = 'RunAccessError';
  }
}

export interface OwnedRun {
  readonly ownerRef: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

/** A run whose project does not exist yet (app generation creates it later). */
interface PendingRun {
  readonly ownerRef: string;
  scope: { projectId: string; workspaceId: string } | null;
}

/** `<testRunId>_repair_<suffix>` -> `<testRunId>`; anything else -> null. */
export function parentOfRepairRun(runId: string): string | null {
  const match = /^(.+)_repair_[a-z0-9]{1,16}$/.exec(runId);
  return match === null ? null : (match[1] ?? null);
}

export class RunOwnership {
  private readonly runs = new Map<string, OwnedRun>();
  private readonly pending = new Map<string, PendingRun>();
  private resolvers: ((runId: string) => { projectId: string; workspaceId: string } | null)[] = [];

  constructor(private readonly projects: ProjectEngine) {}

  /** The caller must own an active project and the workspace must belong to it. */
  async assertCanStart(ownerRef: string, projectId: string, workspaceId: string): Promise<void> {
    const project = await this.projects.projects.getProject(projectId).catch(() => null);
    if (project === null || project.ownerRef !== ownerRef || project.status !== 'active') {
      throw new RunAccessError();
    }
    const workspaces = await this.projects.workspaces.listWorkspaces(projectId).catch(() => []);
    if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw new RunAccessError();
    }
  }

  /** Records the owner once; the first record wins and cannot be replaced. */
  record(runId: string, run: OwnedRun): void {
    if (!this.runs.has(runId)) this.runs.set(runId, run);
  }

  /**
   * Records the owner of a run whose project may not exist yet. The owner is
   * fixed here and never changes. If the scope is already known it is attached.
   */
  recordStart(
    runId: string,
    ownerRef: string,
    projectId: string | null,
    workspaceId: string | null,
  ): void {
    if (this.pending.has(runId) || this.runs.has(runId)) return;
    this.pending.set(runId, {
      ownerRef,
      scope: projectId !== null && workspaceId !== null ? { projectId, workspaceId } : null,
    });
  }

  /**
   * Registers a source that can say which project + workspace a run created
   * (the generation manager). Asked lazily, so a scope that appears after
   * plan approval is picked up without any route having to notice.
   */
  addScopeSource(
    source: (runId: string) => { projectId: string; workspaceId: string } | null,
  ): void {
    this.resolvers.push(source);
  }

  /** The run, only for its owner. */
  require(ownerRef: string, runId: string): OwnedRun | PendingRun {
    const run = this.runs.get(runId) ?? this.pending.get(runId);
    if (run === undefined || run.ownerRef !== ownerRef) throw new RunAccessError();
    return run;
  }

  /**
   * The project and workspace a run was started on, or null for an unknown run.
   * Tools use this to hold a run to its own workspace.
   */
  scopeOf(runId: string): { projectId: string; workspaceId: string } | null {
    const direct = this.runs.get(runId);
    if (direct !== undefined) {
      return { projectId: direct.projectId, workspaceId: direct.workspaceId };
    }
    const pendingRun = this.pending.get(runId);
    if (pendingRun !== undefined) {
      const found = pendingRun.scope ?? this.resolveScope(runId);
      if (found !== null) pendingRun.scope = found;
      return found;
    }
    const known = this.resolveScope(runId);
    if (known !== null) return known;
    // An approved test repair runs as a coding run named `<testRunId>_repair_<id>`
    // (see defaultCodingRepairRunner). It inherits the test run's scope, so it can
    // touch only the workspace that test run was started on.
    const parent = parentOfRepairRun(runId);
    if (parent === null) return null;
    const parentRun = this.runs.get(parent);
    if (parentRun !== undefined) {
      return { projectId: parentRun.projectId, workspaceId: parentRun.workspaceId };
    }
    return this.resolveScope(parent);
  }

  private resolveScope(runId: string): { projectId: string; workspaceId: string } | null {
    for (const source of this.resolvers) {
      const found = source(runId);
      if (found !== null) return found;
    }
    return null;
  }
}
