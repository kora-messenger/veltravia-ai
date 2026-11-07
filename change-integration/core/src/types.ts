/**
 * Change integration vocabulary (Step 46).
 *
 * A worker never edits the shared project. It proposes a CHANGE SET against a
 * base revision it was given, and the Primary Agent decides whether that set
 * becomes part of the project. Everything below is either a proposal, a check
 * of a proposal, or the record of a decision.
 */

import type { RevisionActor } from '@veltravia/source-storage-core';

/** What a change set wants to do to one path. */
export type ChangeOp = 'create' | 'update' | 'delete';

/** One proposed file change, expressed as hashes plus an artifact reference. */
export interface ChangeFile {
  readonly path: string;
  readonly op: ChangeOp;
  /** Content hash the worker started from; `null` when the file did not exist. */
  readonly baseHash: string | null;
  /** Content hash the worker proposes; `null` for a deletion. */
  readonly proposedHash: string | null;
  readonly size: number;
  /**
   * Where the proposed content lives. The change set record itself stays small;
   * evidence and contents are looked up by this reference.
   */
  readonly artifactRef: string | null;
}

/** The permission envelope a change set was produced under. */
export interface ChangeAuthorization {
  /** Paths or path prefixes the assignment allowed. */
  readonly allowedPaths: readonly string[];
  /** Paths or path prefixes the assignment excluded. */
  readonly excludedPaths: readonly string[];
  /** Tools the assignment named. A set claiming writes needs `project.write`. */
  readonly allowedTools: readonly string[];
  readonly taskId: string | null;
  readonly workerId: string | null;
}

/** Verification evidence attached to a change set, by run id. */
export interface ChangeVerification {
  readonly runIds: readonly string[];
  /** `none` means nothing was executed; it is never a pass. */
  readonly status: 'none' | 'passed' | 'failed' | 'unknown';
}

export const CHANGE_SET_STATUSES = [
  'open',
  'integrating',
  'integrated',
  'superseded',
  'rejected',
  'rolled_back',
] as const;
export type ChangeSetStatus = (typeof CHANGE_SET_STATUSES)[number];

/** An isolated, reviewable proposal produced by one worker. */
export interface WorkerChangeSet {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly taskId: string | null;
  readonly workerId: string | null;
  /** Project revision the worker saw. Integration is refused against another. */
  readonly baseRevision: number;
  readonly title: string;
  readonly files: readonly ChangeFile[];
  /** Paths this set claims as its outputs, used to spot invalidated work. */
  readonly deliverables: readonly string[];
  readonly authorization: ChangeAuthorization;
  readonly verification: ChangeVerification;
  readonly status: ChangeSetStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set once the set has been integrated, so it can never be applied twice. */
  readonly integrationId: string | null;
  /** True when the set only proposes what its authorized scope covers. */
  readonly scopeComplete: boolean;
}

/** The pieces of a change set a caller supplies. */
export interface ChangeSetDraft {
  readonly projectId: string;
  readonly workspaceId?: string;
  readonly taskId?: string | null;
  readonly workerId?: string | null;
  readonly baseRevision: number;
  readonly title?: string;
  readonly files: readonly {
    readonly path: string;
    readonly op: ChangeOp;
    readonly baseHash?: string | null;
    readonly content?: string | null;
    readonly proposedHash?: string | null;
    readonly artifactRef?: string | null;
  }[];
  readonly deliverables?: readonly string[];
  readonly authorization?: Partial<ChangeAuthorization>;
  readonly verification?: Partial<ChangeVerification>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const CHANGE_PROBLEM_CODES = [
  'CHANGE_SET_EMPTY',
  'CHANGE_SET_TOO_LARGE',
  'CHANGE_SET_PATH_UNSAFE',
  'CHANGE_SET_PATH_DUPLICATE',
  'CHANGE_SET_UNAUTHORIZED_PATH',
  'CHANGE_SET_EXCLUDED_PATH',
  'CHANGE_SET_SECRET_REJECTED',
  'CHANGE_SET_HASH_MISSING',
  'CHANGE_SET_HASH_INVALID',
  'CHANGE_SET_OPERATION_INVALID',
  'CHANGE_SET_DELETE_WITH_CONTENT',
  'CHANGE_SET_UPDATE_WITHOUT_BASE',
  'CHANGE_SET_PROJECT_MISMATCH',
] as const;
export type ChangeProblemCode = (typeof CHANGE_PROBLEM_CODES)[number];

export interface ChangeProblem {
  readonly code: ChangeProblemCode;
  readonly path: string | null;
  readonly message: string;
}

export interface ChangeValidation {
  readonly ok: boolean;
  readonly problems: readonly ChangeProblem[];
  /** Per-file stalenness against the tree the integrator is about to write. */
  readonly stale: readonly { readonly path: string; readonly reason: string }[];
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export const CONFLICT_KINDS = [
  /** Two sets propose different content for one path. */
  'same-file',
  /** One set deletes a path another modifies. */
  'delete-modify',
  /** One set moves a path another modifies. */
  'rename-modify',
  /** Two sets change overlapping line regions of one file. */
  'overlapping-region',
  /** The set's base hash no longer matches the project. */
  'stale-file',
  /** The whole project moved on since the set was drafted. */
  'stale-base',
  /** Two sets change dependency declarations that cannot both hold. */
  'dependency',
  /** Two sets change the same configuration file differently. */
  'config',
  /** Two sets change the same schema or migration. */
  'schema',
  /** A set removes something another set lists as a deliverable. */
  'invalidates-deliverable',
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export interface ChangeConflict {
  readonly kind: ConflictKind;
  readonly paths: readonly string[];
  readonly changeSetIds: readonly string[];
  /** True when the two sides propose the same content, so nothing is lost. */
  readonly convergent: boolean;
  readonly message: string;
  readonly suggestion: string;
}

/** Outcome of comparing one set against the project and its peers. */
export interface ConflictReport {
  readonly changeSetId: string;
  readonly conflicts: readonly ChangeConflict[];
  /** Files nobody else touches and whose base hash still matches. */
  readonly independentPaths: readonly string[];
  readonly blocked: boolean;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export const INTEGRATION_DECISIONS = ['approve', 'reject'] as const;
export type IntegrationDecision = (typeof INTEGRATION_DECISIONS)[number];

/**
 * A recorded decision by the Primary Agent.
 *
 * A worker's own "done" is never an approval; this record is, and it names the
 * change sets and the conflicts the approver saw.
 */
export interface IntegrationApproval {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string;
  readonly changeSetIds: readonly string[];
  readonly decision: IntegrationDecision;
  readonly actor: string;
  readonly rationale: string;
  readonly conflictsSeen: readonly ConflictKind[];
  readonly verificationRequired: boolean;
  readonly at: string;
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

export const INTEGRATION_STATUSES = [
  'pending',
  'applying',
  'integrated',
  'needs_review',
  'failed',
  'rolled_back',
  'interrupted',
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export interface AppliedFile {
  readonly path: string;
  readonly op: ChangeOp;
  readonly baseHash: string | null;
  readonly contentHash: string | null;
  /** Hash the project held immediately after this integration. */
  readonly afterHash: string | null;
}

export interface IntegrationRecord {
  readonly id: string;
  readonly ownerRef: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly changeSetIds: readonly string[];
  readonly approvalId: string;
  readonly baseRevision: number;
  readonly resultRevision: number | null;
  readonly status: IntegrationStatus;
  readonly applied: readonly AppliedFile[];
  readonly conflicts: readonly ChangeConflict[];
  /** Snapshot taken before the first write; the rollback target. */
  readonly rollbackSnapshotId: string | null;
  readonly rollback: null | {
    readonly at: string;
    readonly actor: string;
    readonly reason: string;
    readonly restoredRevision: number | null;
  };
  readonly verification: null | {
    readonly runId: string;
    readonly status: IntegrationVerificationStatus;
    readonly operations: readonly string[];
    readonly evidenceRunStatus: string | null;
  };
  readonly failure: null | { readonly code: string; readonly message: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type IntegrationVerificationStatus =
  'not_requested' | 'passed' | 'failed' | 'incomplete' | 'unavailable';

export interface IntegrationResult {
  readonly record: IntegrationRecord;
  /** True only when every selected change set reached the project. */
  readonly applied: boolean;
  /** True when the project was restored after a partial attempt. */
  readonly compensated: boolean;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** A path in the project, as the integrator must see it before writing. */
export interface ProjectPathState {
  readonly path: string;
  readonly contentHash: string;
  readonly revision: number;
  readonly size: number;
}

/** The project, workspace and owner a tree operation acts on. */
export interface IntegrationTarget {
  readonly ownerRef: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

/** The project tree, read and written through the existing source storage. */
export interface IntegrationTreePort {
  snapshot(target: IntegrationTarget): Promise<{
    readonly revision: number;
    readonly files: readonly ProjectPathState[];
  }>;
  read(target: IntegrationTarget, path: string): Promise<{ readonly content: string } | null>;
  /** Applies every change, or throws so the caller can compensate. */
  apply(
    input: IntegrationTarget & {
      readonly changes: readonly {
        readonly path: string;
        readonly op: ChangeOp;
        readonly content: string | null;
      }[];
      readonly actor: RevisionActor;
      readonly summary: string;
    },
  ): Promise<{ readonly revision: number; readonly applied: readonly AppliedFile[] }>;
  /** Restores the tree from a snapshot; used only for compensation. */
  restore(
    input: IntegrationTarget & { readonly snapshotId: string },
  ): Promise<{ readonly revision: number }>;
  createSnapshot(
    input: IntegrationTarget & { readonly label: string; readonly note: string },
  ): Promise<{ readonly snapshotId: string }>;
}

/** Contents of a proposed file, kept beside the change set record. */
export interface ChangeArtifactPort {
  put(input: {
    readonly changeSetId: string;
    readonly path: string;
    readonly content: string;
  }): Promise<string>;
  get(input: { readonly changeSetId: string; readonly path: string }): Promise<string | null>;
  delete(changeSetId: string): Promise<void>;
}

export interface ChangeSetStore {
  insert(changeSet: WorkerChangeSet): Promise<void>;
  update(changeSet: WorkerChangeSet): Promise<void>;
  get(ownerRef: string, changeSetId: string): Promise<WorkerChangeSet | null>;
  list(
    ownerRef: string,
    filter?: {
      readonly projectId?: string;
      readonly taskId?: string;
      readonly workerId?: string;
      readonly status?: readonly ChangeSetStatus[];
      readonly limit?: number;
    },
  ): Promise<readonly WorkerChangeSet[]>;
}

export interface ApprovalStore {
  insert(approval: IntegrationApproval): Promise<void>;
  get(ownerRef: string, approvalId: string): Promise<IntegrationApproval | null>;
  list(ownerRef: string, projectId?: string): Promise<readonly IntegrationApproval[]>;
}

export interface IntegrationStore {
  insert(record: IntegrationRecord): Promise<void>;
  update(record: IntegrationRecord): Promise<void>;
  get(ownerRef: string, integrationId: string): Promise<IntegrationRecord | null>;
  list(
    ownerRef: string,
    filter?: {
      readonly projectId?: string;
      readonly status?: readonly IntegrationStatus[];
      readonly limit?: number;
    },
  ): Promise<readonly IntegrationRecord[]>;
}

/** Per-project exclusion, so two integrations cannot interleave. */
export interface IntegrationLockPort {
  acquire(projectId: string, token: string): Promise<boolean>;
  release(projectId: string, token: string): Promise<void>;
  held(projectId: string): Promise<string | null>;
}

/** Post-integration verification, over Step 45. */
export interface IntegrationVerificationPort {
  available(): boolean;
  run(input: {
    readonly ownerRef: string;
    readonly projectId: string;
    readonly operations: readonly string[];
    readonly integrationId: string;
    readonly label: string;
  }): Promise<{
    readonly runId: string;
    readonly status: IntegrationVerificationStatus;
    readonly executed: boolean;
    readonly evidenceStatus: string | null;
  }>;
}

/** Ownership resolution; returns null for missing AND other-owner projects. */
export interface IntegrationProjectsPort {
  resolve(input: {
    readonly ownerRef: string;
    readonly projectId: string;
    readonly workspaceId?: string;
  }): Promise<{ readonly projectId: string; readonly workspaceId: string } | null>;
}

export const CHANGE_INTEGRATION_LIMITS = {
  /** Most files one change set may propose. */
  maxFilesPerChangeSet: 200,
  /** Largest total content one change set may carry. */
  maxBytesPerChangeSet: 2 * 1024 * 1024,
  /** Largest change sets one integration may combine. */
  maxChangeSetsPerIntegration: 16,
  /** How many conflicts one report may carry before it is summarised. */
  maxConflicts: 100,
  /** How long an integration lock is considered live, in milliseconds. */
  lockTtlMs: 60_000,
} as const;
