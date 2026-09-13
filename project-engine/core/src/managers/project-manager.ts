/**
 * ProjectManager - controlled project operations.
 *
 * State transitions are validated (`deleted` is terminal), updates are
 * revision-checked, deletion is SOFT (data is never physically destroyed),
 * and all mutating operations on deleted projects are rejected. The manager
 * also owns the project-level surfaces: context, configuration, integration
 * references, and snapshots.
 */

import {
  IntegrationValidationError,
  ProjectArchivedError,
  ProjectDeletedError,
  ProjectNotFoundError,
  RevisionConflictError,
} from '../errors/index.js';
import {
  isIntegrationStatus,
  type CreateProjectInput,
  type FileNode,
  type IntegrationReference,
  type Project,
  type ProjectConfig,
  type ProjectConfigPatch,
  type ProjectContext,
  type ProjectContextPatch,
  type ProjectPatch,
  type ProjectSnapshot,
  type SnapshotWorkspace,
} from '../types/index.js';
import type {
  FileRepository,
  IntegrationRepository,
  ProjectChangeSet,
  ProjectContextRepository,
  ProjectRepository,
} from '../repositories/index.js';
import { assertProjectTransition } from '../state/index.js';
import {
  buildSnapshot,
  buildSnapshotWorkspace,
  stripConfigMeta,
  stripContextMeta,
} from '../snapshot/index.js';
import {
  validateConfigPatch,
  validateContextPatch,
  validateCreateProjectInput,
  validateProjectPatch,
} from '../validation/index.js';
import { assertNoSecrets, findSecretLikeFields } from '../secrets/index.js';
import { type ProjectManagerOptions, timestamp } from './options.js';

const EMPTY_CONTEXT = {
  goals: [],
  technologyPreferences: [],
  architectureNotes: [],
  buildPreferences: [],
  userInstructions: [],
  decisions: [],
} as const;

const EMPTY_CONFIG = {
  framework: undefined,
  language: undefined,
  runtime: undefined,
  packageManager: undefined,
  buildCommand: undefined,
  testCommand: undefined,
  lintCommand: undefined,
  entryPoints: [],
} as const;

export class ProjectManager {
  private readonly projects: ProjectRepository;
  private readonly workspaces: import('../repositories/index.js').WorkspaceRepository;
  private readonly files: FileRepository;
  private readonly context: ProjectContextRepository;
  private readonly integrations: IntegrationRepository;
  private readonly now: () => Date;

  constructor(options: ProjectManagerOptions) {
    this.projects = options.projects;
    this.workspaces = options.workspaces;
    this.files = options.files;
    this.context = options.context;
    this.integrations = options.integrations;
    this.now = options.now ?? (() => new Date());
  }

  /** Creates a project in the `active` state (initial revision 1). */
  async createProject(input: CreateProjectInput): Promise<Project> {
    const validated = validateCreateProjectInput(input);
    return this.projects.create({
      name: validated.name,
      description: validated.description,
      projectType: validated.projectType,
      ownerRef: validated.ownerRef,
      version: validated.version,
      metadata: validated.metadata,
    });
  }

  /**
   * Returns the project INCLUDING soft-deleted ones, so callers can inspect
   * and restore. Every MUTATING path re-checks the status separately.
   */
  async getProject(projectId: string): Promise<Project> {
    const project = await this.projects.get(projectId);
    if (project === null) {
      throw new ProjectNotFoundError(projectId);
    }
    return project;
  }

  /** Lists projects, excluding soft-deleted ones by default. */
  async listProjects(options?: {
    readonly includeDeleted?: boolean;
    readonly ownerRef?: string;
  }): Promise<Project[]> {
    return this.projects.list(options);
  }

  /** Loads a project that must exist and must NOT be deleted (mutation precondition). */
  private async getMutableProject(projectId: string): Promise<Project> {
    const project = await this.getProject(projectId);
    if (project.status === 'deleted') {
      throw new ProjectDeletedError(projectId);
    }
    return project;
  }

  /**
   * Patches an active or archived project. `expectedRevision` is REQUIRED:
   * an update based on an outdated revision is rejected, never silently
   * applied over newer changes.
   */
  async updateProject(
    projectId: string,
    patch: ProjectPatch,
    expectedRevision: number,
  ): Promise<Project> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new RevisionConflictError('project', expectedRevision, -1);
    }
    const project = await this.getMutableProject(projectId);
    const validated = validateProjectPatch(patch);
    if (expectedRevision !== project.revision) {
      throw new RevisionConflictError('project', expectedRevision, project.revision);
    }
    const change: ProjectChangeSet = {
      patch: {
        ...(validated.name !== undefined ? { name: validated.name } : {}),
        ...(validated.description !== undefined ? { description: validated.description } : {}),
        ...(validated.metadata !== undefined ? { metadata: validated.metadata } : {}),
      },
      expectedRevision,
      updatedAt: timestamp(this.now),
    };
    return this.projects.update(projectId, change);
  }

  /** active -> archived. A deleted project is terminal: invalid transition. */
  async archiveProject(projectId: string): Promise<Project> {
    const project = await this.getProject(projectId);
    assertProjectTransition(project.status, 'archived');
    return this.projects.update(projectId, {
      patch: { status: 'archived' },
      expectedRevision: project.revision,
      updatedAt: timestamp(this.now),
    });
  }

  /** archived -> active. `deleted -> active` is rejected (terminal status). */
  async restoreProject(projectId: string): Promise<Project> {
    const project = await this.getProject(projectId);
    if (project.status === 'deleted') {
      throw new ProjectDeletedError(projectId);
    }
    assertProjectTransition(project.status, 'active');
    return this.projects.update(projectId, {
      patch: { status: 'active' },
      expectedRevision: project.revision,
      updatedAt: timestamp(this.now),
    });
  }

  /**
   * SOFT delete: active|archived -> deleted. The row stays in the repository;
   * nothing is physically destroyed. Deleted projects are terminal.
   */
  async deleteProject(projectId: string): Promise<Project> {
    const project = await this.getProject(projectId);
    assertProjectTransition(project.status, 'deleted');
    return this.projects.update(projectId, {
      patch: { status: 'deleted' },
      expectedRevision: project.revision,
      updatedAt: timestamp(this.now),
    });
  }

  /** Sets the project's default workspace reference (revision-checked). */
  async setDefaultWorkspace(
    projectId: string,
    workspaceId: string,
    expectedRevision: number,
  ): Promise<Project> {
    const project = await this.getMutableProject(projectId);
    const workspace = await this.workspaces.get(workspaceId);
    if (workspace === null || workspace.projectId !== projectId) {
      throw new ProjectNotFoundError(projectId);
    }
    if (expectedRevision !== project.revision) {
      throw new RevisionConflictError('project', expectedRevision, project.revision);
    }
    return this.projects.update(projectId, {
      patch: { workspaceId },
      expectedRevision,
      updatedAt: timestamp(this.now),
    });
  }

  // -----------------------------------------------------------------
  // Project context (structured project data - NOT instructions)
  // -----------------------------------------------------------------

  /** Returns the project context, creating an empty one on first access. */
  async getProjectContext(projectId: string): Promise<ProjectContext> {
    await this.getMutableProject(projectId);
    const existing = await this.context.getContext(projectId);
    if (existing !== null) {
      return existing;
    }
    return this.context.saveContext(projectId, EMPTY_CONTEXT, timestamp(this.now));
  }

  /** Replaces whole categories with the patch's values (revision-checked). */
  async updateProjectContext(
    projectId: string,
    patch: ProjectContextPatch,
    expectedRevision: number,
  ): Promise<ProjectContext> {
    const project = await this.getMutableProject(projectId);
    if (project.status === 'archived') {
      throw new ProjectArchivedError(projectId);
    }
    const validated = validateContextPatch(patch);
    const existing = await this.getProjectContext(projectId);
    if (expectedRevision !== existing.revision) {
      throw new RevisionConflictError('project context', expectedRevision, existing.revision);
    }
    const merged = {
      goals: validated.goals ?? existing.goals,
      technologyPreferences: validated.technologyPreferences ?? existing.technologyPreferences,
      architectureNotes: validated.architectureNotes ?? existing.architectureNotes,
      buildPreferences: validated.buildPreferences ?? existing.buildPreferences,
      userInstructions: validated.userInstructions ?? existing.userInstructions,
      decisions: validated.decisions ?? existing.decisions,
    };
    return this.context.saveContext(projectId, merged, timestamp(this.now));
  }

  // -----------------------------------------------------------------
  // Project configuration (safe metadata ONLY - never executed)
  // -----------------------------------------------------------------

  /** Returns the project configuration, creating an empty one on first access. */
  async getProjectConfig(projectId: string): Promise<ProjectConfig> {
    await this.getMutableProject(projectId);
    const existing = await this.context.getConfig(projectId);
    if (existing !== null) {
      return existing;
    }
    return this.context.saveConfig(projectId, EMPTY_CONFIG, timestamp(this.now));
  }

  /** Patches the configuration (revision-checked, secret-free enforced). */
  async updateProjectConfig(
    projectId: string,
    patch: ProjectConfigPatch,
    expectedRevision: number,
  ): Promise<ProjectConfig> {
    const project = await this.getMutableProject(projectId);
    if (project.status === 'archived') {
      throw new ProjectArchivedError(projectId);
    }
    const validated = validateConfigPatch(patch);
    const existing = await this.context.getConfig(projectId);
    if (existing === null) {
      const empty = await this.context.saveConfig(projectId, EMPTY_CONFIG, timestamp(this.now));
      if (expectedRevision !== empty.revision) {
        throw new RevisionConflictError('project configuration', expectedRevision, empty.revision);
      }
      const seeded = {
        framework: validated.framework ?? empty.framework,
        language: validated.language ?? empty.language,
        runtime: validated.runtime ?? empty.runtime,
        packageManager: validated.packageManager ?? empty.packageManager,
        buildCommand: validated.buildCommand ?? empty.buildCommand,
        testCommand: validated.testCommand ?? empty.testCommand,
        lintCommand: validated.lintCommand ?? empty.lintCommand,
        entryPoints: validated.entryPoints ?? empty.entryPoints,
      };
      return this.context.saveConfig(projectId, seeded, timestamp(this.now));
    }
    if (expectedRevision !== existing.revision) {
      throw new RevisionConflictError('project configuration', expectedRevision, existing.revision);
    }
    const merged = {
      framework: validated.framework ?? existing.framework,
      language: validated.language ?? existing.language,
      runtime: validated.runtime ?? existing.runtime,
      packageManager: validated.packageManager ?? existing.packageManager,
      buildCommand: validated.buildCommand ?? existing.buildCommand,
      testCommand: validated.testCommand ?? existing.testCommand,
      lintCommand: validated.lintCommand ?? existing.lintCommand,
      entryPoints: validated.entryPoints ?? existing.entryPoints,
    };
    return this.context.saveConfig(projectId, merged, timestamp(this.now));
  }

  // -----------------------------------------------------------------
  // Integration references (credential-FREE by design)
  // -----------------------------------------------------------------

  /**
   * Upserts an integration reference. The project learns THAT an integration
   * is connected - the credential itself lives in the future secure
   * secret/connector system and can never appear here.
   */
  async upsertIntegration(
    projectId: string,
    reference: IntegrationReference,
  ): Promise<IntegrationReference> {
    await this.getMutableProject(projectId);
    const reasons: string[] = [];
    if (
      typeof reference.integrationRef !== 'string' ||
      reference.integrationRef.length === 0 ||
      reference.integrationRef.length > 128
    ) {
      reasons.push('integrationRef must be a non-empty string of at most 128 characters');
    }
    if (
      typeof reference.connectorId !== 'string' ||
      reference.connectorId.length === 0 ||
      reference.connectorId.length > 128
    ) {
      reasons.push('connectorId must be a non-empty string of at most 128 characters');
    }
    if (
      typeof reference.connectionId !== 'string' ||
      reference.connectionId.length === 0 ||
      reference.connectionId.length > 128
    ) {
      reasons.push('connectionId must be a non-empty string of at most 128 characters');
    }
    if (!isIntegrationStatus(reference.status)) {
      reasons.push('status must be connected or disconnected');
    }
    if (reference.metadata !== undefined) {
      if (
        reference.metadata === null ||
        typeof reference.metadata !== 'object' ||
        Array.isArray(reference.metadata)
      ) {
        reasons.push('metadata must be an object');
      } else if (findSecretLikeFields(reference.metadata).length > 0) {
        reasons.push('metadata must be secret-free');
      }
    }
    if (reasons.length > 0) {
      throw new IntegrationValidationError(reasons);
    }
    if (reference.metadata !== undefined) {
      assertNoSecrets('integration reference metadata', reference.metadata);
    }
    return this.integrations.upsert(projectId, reference, timestamp(this.now));
  }

  /** Lists the project's integration references. */
  async listIntegrations(projectId: string): Promise<IntegrationReference[]> {
    await this.getProject(projectId);
    return this.integrations.list(projectId);
  }

  /** Removes an integration reference. */
  async removeIntegration(projectId: string, integrationRef: string): Promise<void> {
    await this.getMutableProject(projectId);
    await this.integrations.remove(projectId, integrationRef);
  }

  // -----------------------------------------------------------------
  // Snapshot
  // -----------------------------------------------------------------

  /**
   * Builds a deterministic, serializable, secret-free snapshot of the
   * project: metadata, workspaces, file-tree METADATA (no contents),
   * configuration, context, and integration references.
   */
  async buildSnapshot(projectId: string): Promise<ProjectSnapshot> {
    const project = await this.getProject(projectId);
    const workspaceRows = await this.workspaces.listByProject(projectId);
    const config = await this.context.getConfig(projectId);
    const context = await this.context.getContext(projectId);

    const workspaces: SnapshotWorkspace[] = [];
    for (const workspace of [...workspaceRows].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const nodes: FileNode[] = await this.files.listAll(workspace.id);
      workspaces.push(buildSnapshotWorkspace(workspace, nodes));
    }

    return buildSnapshot({
      project,
      workspaces,
      config: config === null ? null : stripConfigMeta(config),
      context: context === null ? null : stripContextMeta(context),
      integrations: await this.integrations.list(projectId),
    });
  }
}
