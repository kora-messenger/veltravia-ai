import type { CodingCheckpointPort, CodingCheckpointReport } from '@veltravia/coding-agent-core';
import {
  decideAutomaticCheckpoint,
  type VersionControlManager,
  type ChangeProfile,
} from '@veltravia/version-core';
import type { ProjectEngine } from '@veltravia/project-core';

/**
 * The checkpoint step of a coding run (Step 38).
 *
 * Runs once, after a plan is approved and before the first change:
 *
 *  1. validate that the workspace belongs to the project and is the one the run
 *     was started against,
 *  2. work out how big a change the approved plan describes,
 *  3. take a checkpoint when the policy says the change earns one,
 *  4. hand back a report the person can read.
 *
 * It does not approve anything and cannot widen what the run may do: it only
 * ever reads the plan and writes a revision plus a checkpoint marker.
 */

/** Derives the change profile from what the approved plan says it will touch. */
export function profileOfPlan(plan: {
  readonly filesToModify: readonly string[];
  readonly filesToCreate?: readonly string[] | undefined;
  readonly filesToDelete?: readonly string[] | undefined;
}): ChangeProfile {
  const modify = new Set(plan.filesToModify);
  const create = new Set(plan.filesToCreate ?? []);
  const remove = new Set(plan.filesToDelete ?? []);
  const all = new Set([...modify, ...create, ...remove]);
  return {
    filesAffected: all.size,
    filesDeleted: remove.size,
    // A plan lists deletions up front and a person approved the plan, so a
    // listed deletion is an approved destructive operation.
    destructiveApproved: remove.size > 0,
    // There is no refactor flag on a plan. The honest proxy is a change that
    // rewrites several existing files and adds nothing new; it errs towards
    // taking a checkpoint, which costs little, rather than missing one.
    isRefactor: modify.size >= 3 && create.size === 0,
  };
}

export interface CodingCheckpointOptions {
  readonly projectEngine: ProjectEngine;
  readonly version: VersionControlManager;
}

export function createCodingCheckpointPort(options: CodingCheckpointOptions): CodingCheckpointPort {
  const { projectEngine, version } = options;
  return {
    async beforeApprovedChanges(input): Promise<CodingCheckpointReport> {
      // 1. Validate: the workspace is this project's, and it is still there.
      const workspace = await projectEngine.workspaces.getWorkspace(input.workspaceId);
      if (workspace.projectId !== input.projectId) {
        throw new Error('workspace does not belong to the project');
      }

      // 2. Decide, from the plan alone.
      const decision = decideAutomaticCheckpoint(profileOfPlan(input.plan));
      if (!decision.take) {
        return {
          taken: false,
          checkpointId: null,
          checkpointName: null,
          revisionNumber: workspace.revision,
          reason: decision.reason,
        };
      }

      // 3. Checkpoint the tree as it is now, before anything changes. The
      //    revision is captured here with the agent's own source, so the history
      //    attributes it to the agent; letting createCheckpoint capture it would
      //    label it a manual, user-made version.
      const revision = await version.captureRevision({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        source: 'coding_before',
        message: `Before coding run ${input.runId.slice(0, 12)}: ${input.plan.goal.slice(0, 120)}`,
        createdBy: 'ai-agent',
      });
      const checkpoint = await version.createCheckpoint({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        revisionId: revision.id,
        name: `Before coding run ${input.runId.slice(0, 12)}`,
        description: `Taken automatically before approved changes. ${decision.reason}`,
        createdBy: 'ai-agent',
      });
      return {
        taken: true,
        checkpointId: checkpoint.id,
        checkpointName: checkpoint.name,
        revisionNumber: workspace.revision,
        reason: decision.reason,
      };
    },
  };
}
