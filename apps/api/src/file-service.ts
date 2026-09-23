import {
  FileIntelligenceManager,
  normalizeSafePath,
  type FileAuditEvent,
  type FileScope,
  type ProjectArtifactPublisher,
  type ScopeValidator,
} from '@veltravia/file-intelligence-core';
import { InMemoryFileAssetStore } from '@veltravia/file-intelligence-mock';
import { isProjectError, type ProjectEngine } from '@veltravia/project-core';
import type { VersionControlManager } from '@veltravia/version-core';

export interface FileServiceOptions {
  readonly projectEngine: ProjectEngine;
  readonly versionManager: VersionControlManager;
  readonly now?: () => Date;
  readonly onAudit?: (event: FileAuditEvent) => void;
}
export function createFileIntelligenceService(
  options: FileServiceOptions,
): FileIntelligenceManager {
  const engine = options.projectEngine;
  const scopeValidator: ScopeValidator = {
    validate: async (scope: FileScope) => {
      if (!scope.projectId) return;
      const project = await engine.projects.getProject(scope.projectId);
      if (project.ownerRef !== scope.ownerRef) throw new Error('owner scope mismatch');
      if (scope.workspaceId) {
        const ws = await engine.workspaces.getWorkspace(scope.workspaceId);
        if (ws.projectId !== scope.projectId) throw new Error('workspace scope mismatch');
      }
    },
  };
  const publisher: ProjectArtifactPublisher = {
    publish: async ({ artifact, bytes, projectId, workspaceId, path }) => {
      const safePath = normalizeSafePath(path);
      if (artifact.scope.projectId !== projectId || artifact.scope.workspaceId !== workspaceId)
        throw new Error('artifact scope mismatch');
      if (!/^(text\/|application\/(json|xml|javascript))/.test(artifact.metadata.mimeType))
        throw new Error('Only text-compatible artifacts can become Project Engine files.');
      const content = Buffer.from(bytes).toString('utf8');
      const segments = safePath.split('/');
      for (let i = 1; i < segments.length; i++) {
        const dir = segments.slice(0, i).join('/');
        try {
          await engine.files.getNode(workspaceId, dir);
        } catch (error) {
          if (isProjectError(error) && error.code === 'FILE_NOT_FOUND')
            await engine.files.createDirectory(workspaceId, dir);
          else throw error;
        }
      }
      try {
        const existing = await engine.files.getNode(workspaceId, safePath);
        if (existing.type !== 'file') throw new Error('target is not a file');
        await engine.files.updateFile(workspaceId, safePath, {
          content,
          expectedRevision: existing.revision,
        });
      } catch (error) {
        if (isProjectError(error) && error.code === 'FILE_NOT_FOUND')
          await engine.files.createFile(workspaceId, { path: safePath, content });
        else throw error;
      }
      const revision = await options.versionManager.captureRevision({
        projectId,
        workspaceId,
        source: 'artifact_publish',
        message: `Published artifact ${artifact.id} to ${safePath}`,
      });
      return { revisionId: revision.id };
    },
  };
  return new FileIntelligenceManager({
    store: new InMemoryFileAssetStore(),
    now: options.now,
    onAudit: options.onAudit,
    scopeValidator,
    publisher,
  });
}
