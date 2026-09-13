/**
 * @veltravia/project-mock - deterministic, offline, keyless in-memory
 * implementations of the Project Engine repository interfaces.
 *
 * Tests and CI never require MongoDB, PostgreSQL, Redis, GitHub, cloud
 * storage, external APIs, Gemini, or any network access. A future
 * persistence adapter replaces these behind the SAME interfaces.
 */

import {
  FileTreeManager,
  ProjectManager,
  ProjectNotFoundError,
  RevisionConflictError,
  WorkspaceManager,
  WorkspaceNotFoundError,
  randomIdGenerator,
  timestamp,
  workspaceRoot,
  type FileNode,
  type IntegrationReference,
  type Project,
  type ProjectConfig,
  type ProjectContext,
  type ProjectEngine,
  type Workspace,
} from '@veltravia/project-core';
import type {
  FileNodeChangeSet,
  FileRepository,
  IntegrationRepository,
  NewFileNode,
  NewProject,
  NewWorkspace,
  ProjectChangeSet,
  ProjectContextRepository,
  ProjectRepository,
  WorkspaceChangeSet,
  WorkspaceRepository,
} from '@veltravia/project-core';

/** Deterministic injectable id generator: `prefix-1`, `prefix-2`, ... */
export function createSequentialIdGenerator(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${(counter += 1)}`;
}

/** Options for the in-memory repositories (all injectable for determinism). */
export interface InMemoryRepositoryOptions {
  readonly now?: () => Date;
  readonly generateProjectId?: () => string;
  readonly generateWorkspaceId?: () => string;
  readonly generateNodeId?: () => string;
}

const sortByPath = (a: FileNode, b: FileNode): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

// ---------------------------------------------------------------------------
// ProjectRepository
// ---------------------------------------------------------------------------

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly rows = new Map<string, Project>();
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(options: InMemoryRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateProjectId ?? randomIdGenerator('prj');
  }

  async create(input: NewProject): Promise<Project> {
    const id = this.generateId();
    const now = timestamp(this.now);
    const project: Project = {
      id,
      name: input.name,
      description: input.description,
      status: 'active',
      projectType: input.projectType,
      ownerRef: input.ownerRef,
      workspaceId: null,
      version: input.version,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      metadata: Object.freeze({ ...input.metadata }),
    };
    this.rows.set(id, project);
    return project;
  }

  async get(projectId: string): Promise<Project | null> {
    return this.rows.get(projectId) ?? null;
  }

  async list(options?: {
    readonly includeDeleted?: boolean;
    readonly ownerRef?: string;
  }): Promise<Project[]> {
    const includeDeleted = options?.includeDeleted ?? false;
    return [...this.rows.values()]
      .filter((project) => (includeDeleted ? true : project.status !== 'deleted'))
      .filter((project) =>
        options?.ownerRef !== undefined ? project.ownerRef === options.ownerRef : true,
      )
      .sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
      );
  }

  async update(projectId: string, change: ProjectChangeSet): Promise<Project> {
    const existing = this.rows.get(projectId);
    if (existing === undefined) {
      throw new ProjectNotFoundError(projectId);
    }
    if (change.expectedRevision !== existing.revision) {
      throw new RevisionConflictError('project', change.expectedRevision, existing.revision);
    }
    const updated: Project = {
      ...existing,
      ...(change.patch.name !== undefined ? { name: change.patch.name } : {}),
      ...(change.patch.description !== undefined ? { description: change.patch.description } : {}),
      ...(change.patch.status !== undefined ? { status: change.patch.status } : {}),
      ...(change.patch.version !== undefined ? { version: change.patch.version } : {}),
      ...(change.patch.workspaceId !== undefined ? { workspaceId: change.patch.workspaceId } : {}),
      revision: existing.revision + 1,
      updatedAt: change.updatedAt,
      metadata:
        change.patch.metadata !== undefined
          ? Object.freeze({ ...change.patch.metadata })
          : existing.metadata,
    };
    this.rows.set(projectId, updated);
    return updated;
  }
}

// ---------------------------------------------------------------------------
// WorkspaceRepository
// ---------------------------------------------------------------------------

export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  private readonly rows = new Map<string, Workspace>();
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(options: InMemoryRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateWorkspaceId ?? randomIdGenerator('ws');
  }

  async create(input: NewWorkspace): Promise<Workspace> {
    const id = this.generateId();
    const now = timestamp(this.now);
    const workspace: Workspace = {
      id,
      projectId: input.projectId,
      name: input.name,
      status: 'active',
      root: input.root !== '' ? input.root : workspaceRoot(id),
      revision: 1,
      createdAt: now,
      updatedAt: now,
      metadata: Object.freeze({ ...input.metadata }),
    };
    this.rows.set(id, workspace);
    return workspace;
  }

  async get(workspaceId: string): Promise<Workspace | null> {
    return this.rows.get(workspaceId) ?? null;
  }

  async listByProject(projectId: string): Promise<Workspace[]> {
    return [...this.rows.values()]
      .filter((workspace) => workspace.projectId === projectId)
      .sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
      );
  }

  async update(workspaceId: string, change: WorkspaceChangeSet): Promise<Workspace> {
    const existing = this.rows.get(workspaceId);
    if (existing === undefined) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    if (change.expectedRevision !== existing.revision) {
      throw new RevisionConflictError('workspace', change.expectedRevision, existing.revision);
    }
    const updated: Workspace = {
      ...existing,
      ...(change.patch.name !== undefined ? { name: change.patch.name } : {}),
      ...(change.patch.status !== undefined ? { status: change.patch.status } : {}),
      revision: existing.revision + 1,
      updatedAt: change.updatedAt,
      metadata:
        change.patch.metadata !== undefined
          ? Object.freeze({ ...change.patch.metadata })
          : existing.metadata,
    };
    this.rows.set(workspaceId, updated);
    return updated;
  }

  async bumpRevision(workspaceId: string, updatedAt: string): Promise<Workspace> {
    const existing = this.rows.get(workspaceId);
    if (existing === undefined) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    const updated: Workspace = {
      ...existing,
      revision: existing.revision + 1,
      updatedAt,
    };
    this.rows.set(workspaceId, updated);
    return updated;
  }
}

// ---------------------------------------------------------------------------
// FileRepository
// ---------------------------------------------------------------------------

interface StoredFileNode {
  node: FileNode;
  content: string | null;
}

export class InMemoryFileRepository implements FileRepository {
  private readonly rows = new Map<string, StoredFileNode>();
  private readonly generateId: () => string;

  constructor(options: InMemoryRepositoryOptions = {}) {
    this.generateId = options.generateNodeId ?? randomIdGenerator('node');
  }

  async createNode(input: NewFileNode): Promise<FileNode> {
    const id = this.generateId();
    const node: FileNode = {
      id,
      workspaceId: input.workspaceId,
      path: input.path,
      name: input.name,
      type: input.type,
      parentId: input.parentId,
      size: input.content !== undefined ? Buffer.byteLength(input.content, 'utf8') : 0,
      revision: 1,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.rows.set(`${input.workspaceId}:${id}`, { node, content: input.content ?? null });
    return node;
  }

  async getNode(workspaceId: string, path: string): Promise<FileNode | null> {
    for (const stored of this.rows.values()) {
      if (stored.node.workspaceId === workspaceId && stored.node.path === path) {
        return stored.node;
      }
    }
    return null;
  }

  async getNodeById(workspaceId: string, nodeId: string): Promise<FileNode | null> {
    const stored = this.rows.get(`${workspaceId}:${nodeId}`);
    return stored?.node ?? null;
  }

  async listChildren(workspaceId: string, path: string): Promise<FileNode[]> {
    const prefix = path === '' ? '' : `${path}/`;
    return [...this.rows.values()]
      .map((stored) => stored.node)
      .filter(
        (node) =>
          node.workspaceId === workspaceId && node.path !== path && node.path.startsWith(prefix),
      )
      .filter((node) => !node.path.slice(prefix.length).includes('/'))
      .sort(sortByPath);
  }

  async listAll(workspaceId: string): Promise<FileNode[]> {
    return [...this.rows.values()]
      .map((stored) => stored.node)
      .filter((node) => node.workspaceId === workspaceId)
      .sort(sortByPath);
  }

  async updateNode(
    workspaceId: string,
    nodeId: string,
    change: FileNodeChangeSet,
  ): Promise<FileNode> {
    const key = `${workspaceId}:${nodeId}`;
    const stored = this.rows.get(key);
    if (stored === undefined) {
      throw new Error(`No file tree node with id "${nodeId}" in workspace "${workspaceId}".`);
    }
    if (change.expectedRevision !== stored.node.revision) {
      throw new RevisionConflictError('file', change.expectedRevision, stored.node.revision);
    }
    const content = change.patch.content !== undefined ? change.patch.content : stored.content;
    const node: FileNode = {
      ...stored.node,
      ...(change.patch.path !== undefined ? { path: change.patch.path } : {}),
      ...(change.patch.name !== undefined ? { name: change.patch.name } : {}),
      ...(change.patch.parentId !== undefined ? { parentId: change.patch.parentId } : {}),
      size: content !== null ? Buffer.byteLength(content, 'utf8') : 0,
      revision: stored.node.revision + 1,
      updatedAt: change.updatedAt,
    };
    this.rows.set(key, { node, content });
    return node;
  }

  async moveSubtree(
    workspaceId: string,
    fromPath: string,
    toPath: string,
    updatedAt: string,
  ): Promise<void> {
    const prefix = `${fromPath}/`;
    for (const [key, stored] of this.rows.entries()) {
      if (stored.node.workspaceId !== workspaceId) continue;
      if (stored.node.path.startsWith(prefix)) {
        const newPath = `${toPath}/${stored.node.path.slice(prefix.length)}`;
        this.rows.set(key, {
          node: { ...stored.node, path: newPath, updatedAt },
          content: stored.content,
        });
      }
    }
  }

  async deleteNode(workspaceId: string, nodeId: string): Promise<void> {
    this.rows.delete(`${workspaceId}:${nodeId}`);
  }

  async readContent(workspaceId: string, nodeId: string): Promise<string | null> {
    return this.rows.get(`${workspaceId}:${nodeId}`)?.content ?? null;
  }
}

// ---------------------------------------------------------------------------
// ProjectContextRepository
// ---------------------------------------------------------------------------

interface ContextRow {
  context: ProjectContext;
  revision: number;
}

interface ConfigRow {
  config: Omit<ProjectConfig, 'revision' | 'updatedAt'>;
  revision: number;
  updatedAt: string;
}

export class InMemoryProjectContextRepository implements ProjectContextRepository {
  private readonly contexts = new Map<string, ContextRow>();
  private readonly configs = new Map<string, ConfigRow>();

  async getContext(projectId: string): Promise<ProjectContext | null> {
    const row = this.contexts.get(projectId);
    if (row === undefined) return null;
    return { ...row.context, revision: row.revision };
  }

  async saveContext(
    projectId: string,
    context: Omit<ProjectContext, 'revision' | 'updatedAt'>,
    updatedAt: string,
  ): Promise<ProjectContext> {
    const existing = this.contexts.get(projectId);
    const revision = (existing?.revision ?? 0) + 1;
    const saved: ProjectContext = {
      goals: Object.freeze([...context.goals]),
      technologyPreferences: Object.freeze([...context.technologyPreferences]),
      architectureNotes: Object.freeze([...context.architectureNotes]),
      buildPreferences: Object.freeze([...context.buildPreferences]),
      userInstructions: Object.freeze([...context.userInstructions]),
      decisions: Object.freeze([...context.decisions]),
      revision,
      updatedAt,
    };
    this.contexts.set(projectId, { context: saved, revision });
    return saved;
  }

  async getConfig(projectId: string): Promise<ProjectConfig | null> {
    const row = this.configs.get(projectId);
    if (row === undefined) return null;
    return { ...row.config, revision: row.revision, updatedAt: row.updatedAt } as ProjectConfig;
  }

  async saveConfig(
    projectId: string,
    config: Omit<ProjectConfig, 'revision' | 'updatedAt'>,
    updatedAt: string,
  ): Promise<ProjectConfig> {
    const existing = this.configs.get(projectId);
    const revision = (existing?.revision ?? 0) + 1;
    this.configs.set(projectId, { config, revision, updatedAt });
    return { ...config, revision, updatedAt } as ProjectConfig;
  }
}

// ---------------------------------------------------------------------------
// IntegrationRepository
// ---------------------------------------------------------------------------

export class InMemoryIntegrationRepository implements IntegrationRepository {
  private readonly rows = new Map<string, Map<string, IntegrationReference>>();

  async upsert(
    projectId: string,
    reference: IntegrationReference,
    updatedAt: string,
  ): Promise<IntegrationReference> {
    let projectRows = this.rows.get(projectId);
    if (projectRows === undefined) {
      projectRows = new Map();
      this.rows.set(projectId, projectRows);
    }
    const stored: IntegrationReference = { ...reference, linkedAt: updatedAt };
    projectRows.set(reference.integrationRef, stored);
    return stored;
  }

  async list(projectId: string): Promise<IntegrationReference[]> {
    return [...(this.rows.get(projectId)?.values() ?? [])].sort((a, b) =>
      a.integrationRef < b.integrationRef ? -1 : 1,
    );
  }

  async get(projectId: string, integrationRef: string): Promise<IntegrationReference | null> {
    return this.rows.get(projectId)?.get(integrationRef) ?? null;
  }

  async remove(projectId: string, integrationRef: string): Promise<void> {
    this.rows.get(projectId)?.delete(integrationRef);
  }
}

// ---------------------------------------------------------------------------
// Engine assembly
// ---------------------------------------------------------------------------

/** Options for the assembled engine; same knobs as the repositories. */
export type CreateProjectEngineOptions = InMemoryRepositoryOptions;

/**
 * Assembles a fully in-memory Project Engine: three managers over five
 * deterministic repositories. Development/API default and test baseline.
 */
export function createProjectEngine(options: CreateProjectEngineOptions = {}): ProjectEngine {
  const projects = new InMemoryProjectRepository(options);
  const workspaces = new InMemoryWorkspaceRepository(options);
  const files = new InMemoryFileRepository(options);
  const context = new InMemoryProjectContextRepository();
  const integrations = new InMemoryIntegrationRepository();
  const now = options.now ?? (() => new Date());
  return {
    projects: new ProjectManager({ projects, workspaces, files, context, integrations, now }),
    workspaces: new WorkspaceManager({ projects, workspaces, now }),
    files: new FileTreeManager({ projects, workspaces, files, now }),
  };
}
