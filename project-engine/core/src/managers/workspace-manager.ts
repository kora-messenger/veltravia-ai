/**
 * WorkspaceManager - controlled workspace operations.
 *
 * A workspace ALWAYS belongs to a valid project; unknown project ids, invalid
 * workspace states, and operations against archived workspaces are rejected.
 * `root` is a stable LOGICAL identifier - never a host filesystem path.
 */

import {
  InvalidProjectRequestError,
  ProjectDeletedError,
  ProjectNotFoundError,
  RevisionConflictError,
  WorkspaceNotFoundError,
} from '../errors/index.js';
import type { Workspace, WorkspacePatch, WorkspaceStatus } from '../types/index.js';
import type {
  ProjectRepository,
  WorkspaceChangeSet,
  WorkspaceRepository,
} from '../repositories/index.js';
import { assertWorkspaceTransition } from '../state/index.js';
import { assertNoSecrets } from '../secrets/index.js';
import { type WorkspaceManagerOptions, timestamp } from './options.js';

const MAX_NAME_LENGTH = 128;
const MAX_METADATA_BYTES = 16 * 1024;

function validateWorkspaceName(name: unknown): string {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    name.trim() !== name
  ) {
    throw new InvalidProjectRequestError([
      `workspace name must be a non-empty, trimmed string of at most ${MAX_NAME_LENGTH} characters`,
    ]);
  }
  return name;
}

export class WorkspaceManager {
  private readonly projects: ProjectRepository;
  private readonly workspaces: WorkspaceRepository;
  private readonly now: () => Date;

  constructor(options: WorkspaceManagerOptions) {
    this.projects = options.projects;
    this.workspaces = options.workspaces;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Creates a workspace under a project. The project must exist and be
   * ACTIVE - workspaces cannot be created for archived or deleted projects.
   */
  async createWorkspace(
    projectId: string,
    input: { readonly name: string; readonly metadata?: Record<string, unknown> },
  ): Promise<Workspace> {
    const project = await this.projects.get(projectId);
    if (project === null) {
      throw new ProjectNotFoundError(projectId);
    }
    if (project.status === 'deleted') {
      throw new ProjectDeletedError(projectId);
    }
    if (project.status === 'archived') {
      throw new InvalidProjectRequestError([
        `project "${projectId}" is archived; restore it before creating workspaces`,
      ]);
    }
    const name = validateWorkspaceName(input.name);
    if (input.metadata !== undefined) {
      if (
        typeof input.metadata !== 'object' ||
        input.metadata === null ||
        Array.isArray(input.metadata)
      ) {
        throw new InvalidProjectRequestError(['workspace metadata must be an object']);
      }
      assertNoSecrets('workspace metadata', input.metadata);
    }
    // The repository owns identity (like a database would): it assigns the id
    // and derives the stable logical root from it.
    return this.workspaces.create({
      projectId,
      name,
      root: '',
      metadata: input.metadata ?? {},
    });
  }

  /** Returns the workspace (workspaces are never physically deleted). */
  async getWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = await this.workspaces.get(workspaceId);
    if (workspace === null) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    return workspace;
  }

  /** Lists the workspaces of a project (the project must exist). */
  async listWorkspaces(projectId: string): Promise<Workspace[]> {
    await this.getProjectOrThrow(projectId);
    return this.workspaces.listByProject(projectId);
  }

  private async getProjectOrThrow(projectId: string): Promise<void> {
    const project = await this.projects.get(projectId);
    if (project === null) {
      throw new ProjectNotFoundError(projectId);
    }
  }

  /**
   * Patches a workspace (name/metadata). `expectedRevision` is REQUIRED.
   * Archived workspaces cannot be patched; restore them first.
   */
  async updateWorkspace(
    workspaceId: string,
    patch: WorkspacePatch,
    expectedRevision: number,
  ): Promise<Workspace> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new RevisionConflictError('workspace', expectedRevision, -1);
    }
    const workspace = await this.getWorkspace(workspaceId);
    if (workspace.status === 'archived') {
      throw new InvalidProjectRequestError([
        `workspace "${workspaceId}" is archived; restore it before updating`,
      ]);
    }
    if (patch.name !== undefined) {
      validateWorkspaceName(patch.name);
    }
    if (patch.metadata !== undefined) {
      if (
        typeof patch.metadata !== 'object' ||
        patch.metadata === null ||
        Array.isArray(patch.metadata)
      ) {
        throw new InvalidProjectRequestError(['workspace metadata must be an object']);
      }
      if (JSON.stringify(patch.metadata).length > MAX_METADATA_BYTES) {
        throw new InvalidProjectRequestError(['workspace metadata must be at most 16384 bytes']);
      }
      assertNoSecrets('workspace metadata', patch.metadata);
    }
    if (patch.name === undefined && patch.metadata === undefined) {
      throw new InvalidProjectRequestError(['workspace patch must contain at least one field']);
    }
    if (expectedRevision !== workspace.revision) {
      throw new RevisionConflictError('workspace', expectedRevision, workspace.revision);
    }
    const change: WorkspaceChangeSet = {
      patch: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      },
      expectedRevision,
      updatedAt: timestamp(this.now),
    };
    return this.workspaces.update(workspaceId, change);
  }

  private async transition(workspaceId: string, to: WorkspaceStatus): Promise<Workspace> {
    const workspace = await this.getWorkspace(workspaceId);
    assertWorkspaceTransition(workspace.status, to);
    return this.workspaces.update(workspaceId, {
      patch: { status: to },
      expectedRevision: workspace.revision,
      updatedAt: timestamp(this.now),
    });
  }

  /** active -> locked (writes frozen; reads stay available). */
  async lockWorkspace(workspaceId: string): Promise<Workspace> {
    return this.transition(workspaceId, 'locked');
  }

  /** locked -> active. */
  async unlockWorkspace(workspaceId: string): Promise<Workspace> {
    return this.transition(workspaceId, 'active');
  }

  /** active|locked -> archived (frozen; restorable). */
  async archiveWorkspace(workspaceId: string): Promise<Workspace> {
    return this.transition(workspaceId, 'archived');
  }

  /** archived -> active. */
  async restoreWorkspace(workspaceId: string): Promise<Workspace> {
    return this.transition(workspaceId, 'active');
  }
}
