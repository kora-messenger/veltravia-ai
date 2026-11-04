/**
 * Branch model (Step 38).
 *
 * A branch is a NAME that owns one workspace (the live tree) and points at a
 * head revision (an immutable Step 18 snapshot). It stores no file content of
 * its own: revisions, diffs, checkpoints and rollback all stay in Step 18.
 *
 * Isolation comes from the Workspace Engine, not from this record. Each
 * branch has its OWN workspace, so a write to one branch cannot reach another.
 */

export const BRANCH_STATES = ['active', 'archived'] as const;
export type BranchState = (typeof BRANCH_STATES)[number];

export function isBranchState(value: unknown): value is BranchState {
  return typeof value === 'string' && (BRANCH_STATES as readonly string[]).includes(value);
}

/** Who made a change, so the history can tell a person from the agent. */
export const CHANGE_ACTORS = ['user', 'ai-agent', 'system'] as const;
export type ChangeActor = (typeof CHANGE_ACTORS)[number];

export function isChangeActor(value: unknown): value is ChangeActor {
  return typeof value === 'string' && (CHANGE_ACTORS as readonly string[]).includes(value);
}

export interface Branch {
  readonly id: string;
  readonly projectId: string;
  /** The workspace that holds this branch's live files. One per branch. */
  readonly workspaceId: string;
  /** Unique within the project, case-insensitively. */
  readonly name: string;
  readonly description: string | null;
  readonly state: BranchState;
  /** True for the branch the project started on. It cannot be deleted. */
  readonly isDefault: boolean;
  /** The revision this branch was created from, or null for the first branch. */
  readonly baseRevisionId: string | null;
  /** The branch it was created from, or null for the first branch. */
  readonly parentBranchId: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  /** Set when archived. Archiving never deletes revisions or files. */
  readonly archivedAt: string | null;
}

/** What the project is currently working on. One per project. */
export interface ActiveBranch {
  readonly projectId: string;
  readonly branchId: string;
  readonly switchedAt: string;
  readonly switchedBy: string;
}

/** Why an automatic checkpoint was taken. A closed list: no free-text triggers. */
export const CHECKPOINT_TRIGGERS = [
  'before_ai_change',
  'before_refactor',
  'before_destructive',
  'before_restore',
] as const;
export type CheckpointTrigger = (typeof CHECKPOINT_TRIGGERS)[number];

export function isCheckpointTrigger(value: unknown): value is CheckpointTrigger {
  return typeof value === 'string' && (CHECKPOINT_TRIGGERS as readonly string[]).includes(value);
}

/** Facts about a change that decide whether it earns an automatic checkpoint. */
export interface ChangeProfile {
  /** Files the change touches (created, edited or removed). */
  readonly filesAffected: number;
  /** Files the change removes. */
  readonly filesDeleted: number;
  /** True when a person approved a destructive operation. */
  readonly destructiveApproved: boolean;
  /** True when the change restructures existing code rather than adding to it. */
  readonly isRefactor: boolean;
}

export interface CheckpointDecision {
  readonly take: boolean;
  readonly trigger: CheckpointTrigger | null;
  /** Plain words for the history: why one was (or was not) taken. */
  readonly reason: string;
}

/** An entry in the history: one revision, annotated for display. */
export interface HistoryEntry {
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly branchId: string;
  readonly branchName: string;
  readonly description: string;
  readonly createdAt: string;
  readonly actor: ChangeActor;
  /** The identity behind it: the person, or the agent run that made it. */
  readonly author: string;
  /** What kind of change this was, in plain terms. */
  readonly changeType: 'initial' | 'edit' | 'ai-change' | 'restore' | 'branch' | 'checkpoint';
  readonly filesChanged: number;
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  /** The checkpoints that pin this revision, if any. */
  readonly checkpointIds: readonly string[];
  readonly checkpointNames: readonly string[];
  readonly source: string;
}

export const BRANCH_LIMITS = {
  maxBranchesPerProject: 25,
  maxNameLength: 64,
  maxDescriptionLength: 500,
} as const;
