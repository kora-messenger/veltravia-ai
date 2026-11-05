import type { ProjectEngine } from '@veltravia/project-core';

/**
 * Who may touch which testing run.
 *
 * The testing manager keys runs by id alone, so anyone who learned an id could
 * read, approve or cancel the run. This ledger records the owner that started
 * each run and decides access. It is deliberately small:
 *
 *  - A run is visible only to its owner. Someone else's run and a run that does
 *    not exist are indistinguishable, so ids cannot be probed.
 *  - Starting a run needs the project to belong to the caller. A project that
 *    belongs to someone else and one that does not exist look the same.
 *  - The workspace must belong to that project.
 *
 * Owner identity comes from the server's own request handling, never from the
 * request body.
 */

export type OwnershipFailure = 'NOT_FOUND';

export class TestingAccessError extends Error {
  readonly code: OwnershipFailure = 'NOT_FOUND';
  constructor() {
    // One message for every cause, on purpose.
    super('That project or testing run was not found.');
    this.name = 'TestingAccessError';
  }
}

export interface RunRecord {
  readonly ownerRef: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

export class TestingRunLedger {
  private readonly runs = new Map<string, RunRecord>();

  constructor(private readonly projects: ProjectEngine) {}

  /**
   * Confirms the caller owns an active project and that the workspace belongs
   * to it. Throws TestingAccessError for every kind of miss.
   */
  async assertCanStart(ownerRef: string, projectId: string, workspaceId: string): Promise<void> {
    const project = await this.projects.projects.getProject(projectId).catch(() => null);
    if (project === null || project.ownerRef !== ownerRef || project.status !== 'active') {
      throw new TestingAccessError();
    }
    const workspaces = await this.projects.workspaces.listWorkspaces(projectId).catch(() => []);
    if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw new TestingAccessError();
    }
  }

  /** Records who started a run. Called once, after the run exists. */
  record(runId: string, record: RunRecord): void {
    if (!this.runs.has(runId)) this.runs.set(runId, record);
  }

  /** Returns the run's record only to its owner; everyone else gets a miss. */
  require(ownerRef: string, runId: string): RunRecord {
    const record = this.runs.get(runId);
    if (record === undefined || record.ownerRef !== ownerRef) throw new TestingAccessError();
    return record;
  }

  /** Runs owned by the caller, newest last. Never includes anyone else's. */
  list(ownerRef: string): readonly { readonly runId: string; readonly record: RunRecord }[] {
    return [...this.runs.entries()]
      .filter(([, record]) => record.ownerRef === ownerRef)
      .map(([runId, record]) => ({ runId, record }));
  }
}
