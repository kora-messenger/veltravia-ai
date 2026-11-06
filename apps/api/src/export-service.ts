import type { ProjectEngine } from '@veltravia/project-core';
import {
  ExportManager,
  type ArchiveStore,
  type ExportNode,
  type ExportSourcePort,
} from '@veltravia/export-core';

/**
 * Native export wiring (Step 40, phase 2).
 *
 * The export reads through the SAME project engine every other feature uses:
 * no second project store, no host filesystem. Ownership is the same rule the
 * source layer applies - a project that is missing, deleted or someone else's
 * resolves to null, so the three cases cannot be told apart.
 *
 * It is READ-ONLY: this port exposes no write method at all.
 */
export function createExportSourcePort(projectEngine: ProjectEngine): ExportSourcePort {
  return {
    async resolveProject({ ownerRef, projectId }) {
      let project;
      try {
        project = await projectEngine.projects.getProject(projectId);
      } catch {
        return null;
      }
      if (project.ownerRef !== ownerRef || project.status === 'deleted') return null;
      const workspaces = await projectEngine.workspaces.listWorkspaces(project.id);
      // Same choice the source explorer makes, so an export matches what the user sees.
      const chosen = workspaces.find((w) => w.status !== 'archived') ?? workspaces[0];
      if (chosen === undefined) return null;
      return { projectId: project.id, workspaceId: chosen.id, name: project.name };
    },
    async listNodes(workspaceId): Promise<readonly ExportNode[]> {
      const nodes = await projectEngine.files.listAll(workspaceId);
      return nodes.map((node) => ({
        path: node.path,
        type: node.type,
        revision: node.revision,
      }));
    },
    async workspaceRevision(workspaceId) {
      const workspace = await projectEngine.workspaces.getWorkspace(workspaceId);
      return workspace?.revision ?? 0;
    },
    async readFile(workspaceId, path) {
      // The engine returns the whole file; nothing here shortens it.
      const read = await projectEngine.files.readFile(workspaceId, path);
      return { revision: read.node.revision, content: read.content };
    },
  };
}

export interface ExportServiceOptions {
  readonly projectEngine: ProjectEngine;
  readonly store?: ArchiveStore;
  readonly now?: () => Date;
}

export function createExportService(options: ExportServiceOptions): ExportManager {
  return new ExportManager({
    source: createExportSourcePort(options.projectEngine),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
