import {
  InMemoryContentStore,
  SourceRepositoryManager,
  type SourceProjectsPort,
  type SourceRepositoryManager as SourceManager,
  type SourceTreeNode,
  type SourceTreePort,
} from '@veltravia/source-storage-core';
import type { FileNode, ProjectEngine } from '@veltravia/project-core';

/**
 * Native source storage wiring (Step 31).
 *
 * The ports are implemented over the SAME project engine every other feature
 * uses: the coding agent, the app builder and the sandbox all write into one
 * tree, and this service adds history, atomic change sets and snapshots on top
 * of it. There is no second store and no filesystem access here.
 */

function toNode(node: FileNode): SourceTreeNode {
  return {
    path: node.path,
    type: node.type,
    revision: node.revision,
    updatedAt: node.updatedAt,
  };
}

export function createSourceTreePort(projectEngine: ProjectEngine): SourceTreePort {
  const files = projectEngine.files;
  return {
    async listAll(workspaceId) {
      const nodes = await files.listAll(workspaceId);
      return nodes.map(toNode);
    },
    async readFile(workspaceId, path) {
      const read = await files.readFile(workspaceId, path);
      return { revision: read.node.revision, content: read.content };
    },
    async createFile(workspaceId, path, content) {
      const node = await files.createFile(workspaceId, { path, content });
      return { revision: node.revision };
    },
    async updateFile(workspaceId, path, content, expectedRevision) {
      const node = await files.updateFile(workspaceId, path, { content, expectedRevision });
      return { revision: node.revision };
    },
    async deleteFile(workspaceId, path) {
      await files.deleteFile(workspaceId, path);
    },
    async createDirectory(workspaceId, path) {
      const node = await files.createDirectory(workspaceId, path);
      return { revision: node.revision };
    },
    async deleteDirectory(workspaceId, path) {
      await files.deleteDirectory(workspaceId, path);
    },
    async moveNode(workspaceId, fromPath, toDirectory) {
      const node = await files.moveNode(workspaceId, { fromPath, toDirectory });
      return { path: node.path, revision: node.revision };
    },
    async renameNode(workspaceId, path, newName) {
      const node = await files.renameNode(workspaceId, { path, newName });
      return { path: node.path, revision: node.revision };
    },
    async rootRevision(workspaceId) {
      const workspace = await projectEngine.workspaces.getWorkspace(workspaceId);
      return workspace?.revision ?? 0;
    },
  };
}

/**
 * Ownership resolution over the project engine.
 *
 * Returns `null` for "no such project" AND for "not yours", so the caller
 * cannot distinguish them and existence never leaks across owners.
 */
export function createSourceProjectsPort(projectEngine: ProjectEngine): SourceProjectsPort {
  return {
    async resolveRepository(input) {
      let project;
      try {
        project = await projectEngine.projects.getProject(input.projectId);
      } catch {
        return null;
      }
      if (project.ownerRef !== input.ownerRef) return null;
      if (project.status === 'deleted') return null;

      if (input.workspaceId !== undefined) {
        const workspace = await projectEngine.workspaces.getWorkspace(input.workspaceId);
        if (workspace === null || workspace.projectId !== project.id) return null;
        return { projectId: project.id, workspaceId: workspace.id };
      }

      const workspaces = await projectEngine.workspaces.listWorkspaces(project.id);
      const active = workspaces.filter((workspace) => workspace.status !== 'archived');
      const chosen = active[0] ?? workspaces[0];
      if (chosen === undefined) return null;
      return { projectId: project.id, workspaceId: chosen.id };
    },
  };
}

export interface SourceServiceOptions {
  readonly projectEngine: ProjectEngine;
  readonly store?: InMemoryContentStore;
  readonly now?: () => Date;
  readonly generateId?: () => string;
}

export function createSourceService(options: SourceServiceOptions): SourceManager {
  return new SourceRepositoryManager({
    projects: createSourceProjectsPort(options.projectEngine),
    tree: createSourceTreePort(options.projectEngine),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.generateId === undefined ? {} : { generateId: options.generateId }),
  });
}
